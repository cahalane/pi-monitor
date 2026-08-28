/**
 * WebSocket target validation for the monitor extension.
 *
 * Mirrors the Claude Code Monitor rules: ws/wss only, ASCII only, no embedded credentials, valid
 * unique subprotocol tokens, and no host that resolves to a private, loopback, link-local or
 * cloud-metadata address.
 */

import { lookup } from "node:dns/promises";

export interface ValidatedWsTarget {
	url: string;
	hostname: string;
	protocols: string[];
}

const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function validateWsTarget(rawUrl: string, protocols: string[] = []): ValidatedWsTarget {
	if (rawUrl !== rawUrl.trim() || /\s/.test(rawUrl)) {
		throw new Error("WebSocket URL must not contain whitespace");
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we reject
	if (/[^\x21-\x7e]/.test(rawUrl)) {
		throw new Error("WebSocket URL must be printable ASCII");
	}

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Not a valid URL: ${rawUrl}`);
	}

	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`WebSocket URL must use ws:// or wss://, got ${url.protocol}`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new Error("WebSocket URL must not embed credentials");
	}

	const seen = new Set<string>();
	for (const protocol of protocols) {
		if (!SUBPROTOCOL_TOKEN.test(protocol)) {
			throw new Error(`Invalid WebSocket subprotocol token: ${JSON.stringify(protocol)}`);
		}
		if (seen.has(protocol)) {
			throw new Error(`Duplicate WebSocket subprotocol: ${protocol}`);
		}
		seen.add(protocol);
	}

	return { url: url.toString(), hostname: url.hostname, protocols: [...seen] };
}

/** True for addresses a monitor must never reach: loopback, private, link-local, metadata, CGNAT. */
export function isBlockedAddress(address: string): boolean {
	const value = address.trim().toLowerCase();
	if (value === "") return true;

	const mapped = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
	if (mapped.includes(".")) return isBlockedIpv4(mapped);
	return isBlockedIpv6(value);
}

function isBlockedIpv4(address: string): boolean {
	const parts = address.split(".");
	if (parts.length !== 4) return true;
	const octets = parts.map((part) => Number(part));
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
	const [a, b] = octets as [number, number, number, number];

	if (a === 0) return true; // "this network", and 0.0.0.0
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254 metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 and 192.0.2.0/24
	if (a >= 224) return true; // multicast and reserved
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const value = address.split("%")[0] ?? address; // strip zone id
	if (value === "::" || value === "::1") return true;
	if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
		return true; // fe80::/10 link-local
	}
	const first = value.split(":")[0] ?? "";
	if (first.length >= 2) {
		const prefix = Number.parseInt(first.slice(0, 2), 16);
		if (Number.isInteger(prefix) && prefix >= 0xfc && prefix <= 0xfd) return true; // fc00::/7
	}
	if (value.startsWith("ff")) return true; // multicast
	return false;
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupFn = async (hostname) => lookup(hostname, { all: true });

/**
 * Rejects hosts that resolve to a blocked address.
 *
 * Note: the connection is made by hostname afterwards, so a hostile DNS server could return a
 * public address here and a private one to the connect (a TOCTOU gap). The check still stops the
 * common cases — literal IPs, localhost, and metadata hostnames.
 */
export async function assertPublicHost(hostname: string, resolve: LookupFn = defaultLookup): Promise<void> {
	const bare = hostname.replace(/^\[|]$/g, "");
	if (bare === "localhost" || bare.endsWith(".localhost")) {
		throw new Error(`WebSocket host ${hostname} is not allowed (loopback)`);
	}

	if (isIpLiteral(bare)) {
		if (isBlockedAddress(bare)) {
			throw new Error(`WebSocket host ${hostname} is not allowed (private, loopback or link-local address)`);
		}
		return;
	}

	let records: Array<{ address: string }>;
	try {
		records = await resolve(bare);
	} catch (error) {
		throw new Error(
			`Could not resolve WebSocket host ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (records.length === 0) {
		throw new Error(`WebSocket host ${hostname} did not resolve to any address`);
	}
	for (const record of records) {
		if (isBlockedAddress(record.address)) {
			throw new Error(
				`WebSocket host ${hostname} resolves to ${record.address}, which is private, loopback, link-local or metadata`,
			);
		}
	}
}

function isIpLiteral(value: string): boolean {
	return /^[0-9.]+$/.test(value) || value.includes(":");
}
