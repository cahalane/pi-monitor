import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPublicHost, isBlockedAddress, validateWsTarget } from "../ws-guard.ts";
import type { LookupFn } from "../ws-guard.ts";

test("validateWsTarget rejects http/https schemes", () => {
	assert.throws(() => validateWsTarget("http://example.com"), /ws:\/\/ or wss:\/\//);
	assert.throws(() => validateWsTarget("https://example.com"), /ws:\/\/ or wss:\/\//);
});

test("validateWsTarget rejects whitespace anywhere in the URL", () => {
	assert.throws(() => validateWsTarget("wss://example.com/ path"), /whitespace/);
	assert.throws(() => validateWsTarget(" wss://example.com"), /whitespace/);
});

test("validateWsTarget rejects non-ASCII characters", () => {
	assert.throws(() => validateWsTarget("wss://exámple.com"), /printable ASCII/);
});

test("validateWsTarget rejects embedded credentials", () => {
	assert.throws(() => validateWsTarget("wss://user:pass@example.com"), /credentials/);
});

test("validateWsTarget rejects an invalid subprotocol token", () => {
	assert.throws(() => validateWsTarget("wss://example.com", ["bad proto"]), /Invalid WebSocket subprotocol/);
	assert.throws(() => validateWsTarget("wss://example.com", ["bad,proto"]), /Invalid WebSocket subprotocol/);
});

test("validateWsTarget rejects duplicate subprotocols", () => {
	assert.throws(() => validateWsTarget("wss://example.com", ["json", "json"]), /Duplicate WebSocket subprotocol/);
});

test("validateWsTarget accepts a plain wss URL and normalises fields", () => {
	const result = validateWsTarget("wss://example.com/socket", ["json"]);
	assert.equal(result.url, "wss://example.com/socket");
	assert.equal(result.hostname, "example.com");
	assert.deepEqual(result.protocols, ["json"]);
});

test("isBlockedAddress flags loopback, private, link-local, metadata, CGNAT and multicast", () => {
	const blocked = [
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"::1",
		"fe80::1",
		"fc00::1",
		"::ffff:127.0.0.1",
		"224.0.0.1",
	];
	for (const address of blocked) {
		assert.equal(isBlockedAddress(address), true, `expected ${address} to be blocked`);
	}
});

test("isBlockedAddress allows public IPv4 and IPv6 addresses", () => {
	const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700::1111"];
	for (const address of allowed) {
		assert.equal(isBlockedAddress(address), false, `expected ${address} to be allowed`);
	}
});

test("assertPublicHost rejects localhost and *.localhost", async () => {
	await assert.rejects(assertPublicHost("localhost"), /loopback/);
	await assert.rejects(assertPublicHost("printer.localhost"), /loopback/);
});

test("assertPublicHost rejects an IP literal in a blocked range", async () => {
	await assert.rejects(assertPublicHost("169.254.169.254"), /not allowed/);
});

test("assertPublicHost rejects a hostname whose lookup returns any blocked address", async () => {
	const lookup: LookupFn = async () => [{ address: "8.8.8.8" }, { address: "10.0.0.5" }];
	await assert.rejects(assertPublicHost("mixed.example.com", lookup), /resolves to 10\.0\.0\.5/);
});

test("assertPublicHost accepts a hostname that resolves only to public addresses", async () => {
	const lookup: LookupFn = async () => [{ address: "8.8.8.8" }, { address: "1.1.1.1" }];
	await assert.doesNotReject(assertPublicHost("public.example.com", lookup));
});

test("assertPublicHost errors clearly when resolution returns no records", async () => {
	const lookup: LookupFn = async () => [];
	await assert.rejects(assertPublicHost("empty.example.com", lookup), /did not resolve to any address/);
});
