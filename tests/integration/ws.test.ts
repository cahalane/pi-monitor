import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { WebSocket } from "undici";
import { WebSocketSource, type PinnedTransport } from "../../sources.ts";
import type { MonitorConfig } from "../../types.ts";

const wsConfig = (url: string): MonitorConfig => ({
	id: "ws",
	name: "ws",
	kind: "ws",
	ws: { url, protocols: [] },
	intervalMs: 1_000,
	timeoutMs: 0,
	persistent: true,
	dedupe: false,
	batchMs: 0,
	maxEvents: 100,
	maxBytes: 64 * 1024,
	wake: false,
	deliverAs: "nextTurn",
});

function frame(text: string): Buffer {
	const payload = Buffer.from(text);
	if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
	const header = Buffer.alloc(10);
	header[0] = 0x81;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}

async function serverFor(message: string): Promise<{ server: Server; url: string }> {
	const server = createServer();
	server.on("upgrade", (request, socket) => {
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string") return socket.destroy();
		const accept = createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		socket.write(frame(message));
		setTimeout(() => socket.destroy(), 100).unref();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("server did not bind");
	return { server, url: `ws://127.0.0.1:${address.port}` };
}

const transport = async (): Promise<PinnedTransport> => ({
	WebSocketImpl: WebSocket as unknown as PinnedTransport["WebSocketImpl"],
	close: async () => {},
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for WebSocket integration event");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const closeServer = async (server: Server): Promise<void> =>
	new Promise((resolve) => server.close(() => resolve()));

test("default WebSocketSource rejects loopback before connecting", async () => {
	const source = new WebSocketSource(wsConfig("ws://127.0.0.1:1"), {
		onLine: () => {},
		onEnd: () => {},
	});
	await assert.rejects(source.start(), /not allowed|private, loopback/);
});

test("WebSocketSource delivers local text frames through a test-only injected transport", async () => {
	const live = await serverFor("alpha\nbeta");
	const lines: string[] = [];
	let closed = false;
	const source = new WebSocketSource(
		wsConfig(live.url),
		{
			onLine: (line) => lines.push(line),
			onEnd: (reason) => {
				closed = reason.kind === "closed";
			},
		},
		{ assertPublicHost: async () => {}, createTransport: transport },
	);
	try {
		await source.start();
		await waitFor(() => lines.length === 2);
		await waitFor(() => closed);
		assert.deepEqual(lines, ["alpha", "beta"]);
	} finally {
		await source.stop();
		await closeServer(live.server);
	}
});

test("WebSocketSource reports and closes an oversized local message", async () => {
	const live = await serverFor("x".repeat(1024 * 1024 + 1));
	let message = "";
	const source = new WebSocketSource(
		wsConfig(live.url),
		{
			onLine: () => {},
			onEnd: (reason) => {
				message = reason.kind === "error" ? reason.message : reason.kind;
			},
		},
		{ assertPublicHost: async () => {}, createTransport: transport },
	);
	try {
		await source.start();
		await waitFor(() => message !== "");
		assert.match(message, /exceeds the 1 MiB limit/);
	} finally {
		await source.stop();
		await closeServer(live.server);
	}
});
