/**
 * Monitor sources: a long-running command, a polled command that reports only changes, and a
 * WebSocket pinned to a validated address.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { clampLine, splitLines, stripAnsi } from "./pipeline.ts";
import { DEFAULTS, type EndReason, type MonitorConfig } from "./types.ts";
import { assertPublicHost, isBlockedAddress } from "./ws-guard.ts";

export interface SourceCallbacks {
	onLine(line: string): void;
	onEnd(reason: EndReason): void;
}

export interface Source {
	start(): Promise<void>;
	/** Terminates the source and resolves once its resources are released. */
	stop(): Promise<void>;
}

const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
const shellFlag = process.platform === "win32" ? "/c" : "-c";

function spawnShell(command: string, cwd: string | undefined): ChildProcess {
	return spawn(shell, [shellFlag, command], {
		cwd,
		// Own process group so a whole pipeline dies with the monitor. Windows has no equivalent
		// here, so stop() there is best effort on the shell process only.
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
}

/** Kills a process group where the platform supports it, then escalates once. */
async function terminate(child: ChildProcess, graceMs: number, deadlineMs: number): Promise<void> {
	const pid = child.pid;
	const processGroupId = process.platform !== "win32" && pid !== undefined ? -pid : undefined;
	const isRunning = (): boolean => {
		if (processGroupId === undefined) return child.exitCode === null && child.signalCode === null;
		try {
			process.kill(processGroupId, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	};
	if (!isRunning()) return;

	const signalTarget = (signal: NodeJS.Signals): void => {
		try {
			if (processGroupId !== undefined) process.kill(processGroupId, signal);
			else child.kill(signal);
		} catch {
			// Already gone, or the group vanished between checks.
		}
	};

	signalTarget("SIGTERM");
	const startedAt = Date.now();
	let escalated = false;
	while (isRunning()) {
		const elapsed = Date.now() - startedAt;
		if (!escalated && elapsed >= graceMs) {
			signalTarget("SIGKILL");
			escalated = true;
		}
		if (elapsed >= deadlineMs) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadlineMs - elapsed)));
	}
}

export class CommandSource implements Source {
	private child: ChildProcess | undefined;
	private stopped = false;
	private carry = { stdout: "", stderr: "" };

	private readonly config: MonitorConfig;
	private readonly callbacks: SourceCallbacks;

	constructor(config: MonitorConfig, callbacks: SourceCallbacks) {
		this.config = config;
		this.callbacks = callbacks;
	}

	async start(): Promise<void> {
		const child = spawnShell(this.config.command ?? "", this.config.cwd);
		this.child = child;

		const pipe = (stream: NodeJS.ReadableStream | null, key: "stdout" | "stderr"): void => {
			stream?.setEncoding("utf8");
			stream?.on("data", (chunk: string) => {
				if (this.stopped) return;
				const { lines, carry } = splitLines(this.carry[key], chunk);
				this.carry[key] = carry.length > 64 * 1024 ? carry.slice(-64 * 1024) : carry;
				for (const line of lines) this.callbacks.onLine(line);
			});
		};
		pipe(child.stdout, "stdout");
		pipe(child.stderr, "stderr");

		child.on("error", (error) => {
			if (this.stopped) return;
			this.callbacks.onEnd({ kind: "error", message: error.message });
		});
		child.on("close", (code, signal) => {
			if (this.stopped) return;
			for (const key of ["stdout", "stderr"] as const) {
				const rest = this.carry[key].trim();
				this.carry[key] = "";
				if (rest.length > 0) this.callbacks.onLine(rest);
			}
			this.callbacks.onEnd({ kind: "exit", code, signal });
		});
	}

	async stop(): Promise<void> {
		this.stopped = true;
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		child.stdout?.removeAllListeners();
		child.stderr?.removeAllListeners();
		await terminate(child, DEFAULTS.killGraceMs, DEFAULTS.stopDeadlineMs);
	}
}

/**
 * Reruns a command on an interval and reports only when its output changes. This is the CI/PR
 * shape: `gh pr checks` prints the same table until something moves.
 */
export class PollSource implements Source {
	private timer: NodeJS.Timeout | undefined;
	private running: ChildProcess | undefined;
	private stopped = false;
	private lastHash: string | undefined;

	private readonly config: MonitorConfig;
	private readonly callbacks: SourceCallbacks;

	constructor(config: MonitorConfig, callbacks: SourceCallbacks) {
		this.config = config;
		this.callbacks = callbacks;
	}

	async start(): Promise<void> {
		await this.tick();
		if (this.stopped) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.config.intervalMs);
		this.timer.unref();
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.running) return;
		const child = spawnShell(this.config.command ?? "", this.config.cwd);
		this.running = child;

		let output = "";
		const collect = (chunk: string): void => {
			if (output.length < DEFAULTS.pollOutputMaxBytes) output += chunk;
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);

		const finished = new Promise<void>((resolve) => {
			child.once("close", () => resolve());
			child.once("error", (error) => {
				output += `poll command failed: ${error.message}`;
				resolve();
			});
		});
		await finished;
		this.running = undefined;
		if (this.stopped) return;

		// Hash the rendered text, not terminal decoration: colour-only churn is not a change.
		const canonical = output
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((raw) => ({ raw, stripped: stripAnsi(raw) }))
			// Drop decoration-only records but preserve meaningful interior blank lines.
			.filter((line) => line.stripped.trim().length > 0 || line.raw.trim().length === 0)
			.map((line) => line.stripped)
			.join("\n")
			.trim();
		const hash = createHash("sha1").update(canonical).digest("hex");
		if (hash === this.lastHash) return;
		const first = this.lastHash === undefined;
		this.lastHash = hash;

		if (canonical.length === 0) {
			this.callbacks.onLine(first ? "(no output)" : "(output became empty)");
			return;
		}
		if (!first) this.callbacks.onLine("--- output changed ---");
		for (const line of canonical.split("\n")) this.callbacks.onLine(clampLine(line));
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		const child = this.running;
		this.running = undefined;
		if (child) await terminate(child, DEFAULTS.killGraceMs, DEFAULTS.stopDeadlineMs);
	}
}

const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

type WebSocketCtor = new (
	url: string,
	options?: { protocols?: string[]; dispatcher?: unknown },
) => WebSocket;

export interface PinnedTransport {
	WebSocketImpl: WebSocketCtor;
	dispatcher?: unknown;
	close(): Promise<void>;
}

export interface WebSocketSourceOptions {
	/** Test-only seams; production construction uses the public-host guard and pinned transport. */
	assertPublicHost?: (hostname: string) => Promise<void>;
	createTransport?: (hostname: string) => Promise<PinnedTransport>;
}

/**
 * Resolves the host once, validates every address, and connects through a dispatcher whose lookup
 * returns only that address. Without this pinning the connect would re-resolve the hostname and a
 * hostile DNS server could answer with a private address after validation passed.
 */
async function createPinnedTransport(hostname: string): Promise<PinnedTransport> {
	const records = await dnsLookup(hostname, { all: true });
	const usable = records.filter((record) => !isBlockedAddress(record.address));
	if (usable.length === 0 || usable.length !== records.length) {
		throw new Error(`WebSocket host ${hostname} resolves to a private, loopback or link-local address`);
	}
	const pinned = usable[0];
	if (!pinned) throw new Error(`WebSocket host ${hostname} did not resolve`);

	let undici: { Agent: new (options: unknown) => { close(): Promise<void> }; WebSocket: WebSocketCtor };
	try {
		const require = createRequire(import.meta.url);
		undici = require("undici");
	} catch {
		if (process.env.PI_MONITOR_ALLOW_UNPINNED_WS === "1") {
			return { WebSocketImpl: globalThis.WebSocket as unknown as WebSocketCtor, async close() {} };
		}
		throw new Error(
			"WebSocket monitors need the 'undici' package to pin the connection to a validated address. " +
				"Run npm install in the monitor extension directory, or set PI_MONITOR_ALLOW_UNPINNED_WS=1 to " +
				"accept an unpinned connection.",
		);
	}

	const agent = new undici.Agent({
		connect: {
			// TLS still verifies and SNIs on the hostname; only the address is fixed.
			lookup: (
				_hostname: string,
				_options: unknown,
				callback: (error: Error | null, address: string, family: number) => void,
			) => callback(null, pinned.address, pinned.family),
		},
	});
	return {
		WebSocketImpl: undici.WebSocket,
		dispatcher: agent,
		close: () => agent.close(),
	};
}

export class WebSocketSource implements Source {
	private socket: WebSocket | undefined;
	private transport: PinnedTransport | undefined;
	private stopped = false;

	private readonly config: MonitorConfig;
	private readonly callbacks: SourceCallbacks;
	private readonly options: WebSocketSourceOptions;

	constructor(config: MonitorConfig, callbacks: SourceCallbacks, options: WebSocketSourceOptions = {}) {
		this.config = config;
		this.callbacks = callbacks;
		this.options = options;
	}

	async start(): Promise<void> {
		const target = this.config.ws;
		if (!target) throw new Error("WebSocket monitor started without a target");
		const hostname = new URL(target.url).hostname.replace(/^\[|]$/g, "");
		await (this.options.assertPublicHost ?? assertPublicHost)(hostname);
		const transport = await (this.options.createTransport ?? createPinnedTransport)(hostname);
		this.transport = transport;
		if (this.stopped) {
			await transport.close();
			return;
		}

		const socket = new transport.WebSocketImpl(target.url, {
			protocols: target.protocols.length > 0 ? target.protocols : undefined,
			dispatcher: transport.dispatcher,
		});
		this.socket = socket;

		socket.addEventListener("message", (event: MessageEvent) => {
			if (this.stopped) return;
			const data = event.data;
			if (typeof data === "string") {
				const bytes = Buffer.byteLength(data, "utf8");
				if (bytes > MAX_WS_MESSAGE_BYTES) {
					this.callbacks.onEnd({
						kind: "error",
						message: `message of ${bytes} bytes exceeds the 1 MiB limit; subscribe to a filtered feed`,
					});
					try {
						socket.close(1009, "message too big");
					} catch {
						// Socket may already be closing.
					}
					return;
				}
				for (const line of data.split(/\r\n?|\n/)) this.callbacks.onLine(line);
				return;
			}
			const size =
				data instanceof ArrayBuffer
					? data.byteLength
					: data instanceof Blob
						? data.size
						: Buffer.byteLength(String(data));
			if (size > MAX_WS_MESSAGE_BYTES) {
				this.callbacks.onEnd({
					kind: "error",
					message: `binary message of ${size} bytes exceeds the 1 MiB limit`,
				});
				try {
					socket.close(1009, "message too big");
				} catch {
					// Socket may already be closing.
				}
				return;
			}
			this.callbacks.onLine(`[binary frame, ${size} bytes]`);
		});
		socket.addEventListener("error", () => {
			if (this.stopped) return;
			this.callbacks.onEnd({ kind: "error", message: "websocket error" });
		});
		socket.addEventListener("close", (event: CloseEvent) => {
			if (this.stopped) return;
			this.callbacks.onEnd({ kind: "closed", code: event.code, reason: event.reason || undefined });
		});
	}

	async stop(): Promise<void> {
		this.stopped = true;
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close(1000, "monitor stopped");
		} catch {
			// Socket already closing.
		}
		const transport = this.transport;
		this.transport = undefined;
		await transport?.close().catch(() => {});
	}
}

export function createSource(config: MonitorConfig, callbacks: SourceCallbacks): Source {
	switch (config.kind) {
		case "command":
			return new CommandSource(config, callbacks);
		case "poll":
			return new PollSource(config, callbacks);
		case "ws":
			return new WebSocketSource(config, callbacks);
	}
}
