/** Shared types and defaults for the monitor extension. */

export type SourceKind = "command" | "poll" | "ws";

export type DeliverAs = "steer" | "followUp" | "nextTurn";

export interface WsTarget {
	url: string;
	protocols: string[];
}

export interface MonitorConfig {
	id: string;
	name: string;
	kind: SourceKind;
	/** Shell command for `command` and `poll` sources. */
	command?: string;
	cwd?: string;
	ws?: WsTarget;
	/** `poll` only: how often to rerun the command. */
	intervalMs: number;
	timeoutMs: number;
	persistent: boolean;
	match?: RegExp;
	ignore?: RegExp;
	/** When a line matches, the watch ends after delivering it. */
	until?: RegExp;
	dedupe: boolean;
	batchMs: number;
	maxEvents: number;
	maxBytes: number;
	wake: boolean;
	deliverAs: DeliverAs;
}

export type MonitorStatus = "running" | "stopping" | "ended";

export type EndReason =
	| { kind: "exit"; code: number | null; signal: string | null }
	| { kind: "closed"; code: number; reason?: string }
	| { kind: "error"; message: string }
	| { kind: "until"; pattern: string }
	| { kind: "timeout"; afterMs: number }
	| { kind: "cap"; detail: string }
	| { kind: "stopped"; by: "tool" | "command" | "shutdown" };

export interface MonitorSnapshot {
	id: string;
	name: string;
	kind: SourceKind;
	source: string;
	status: MonitorStatus;
	events: number;
	bytes: number;
	uptimeMs: number;
	lastEventAgeMs?: number;
	pendingLines: number;
	endReason?: string;
}

export const DEFAULTS = {
	timeoutMs: 300_000,
	intervalMs: 15_000,
	minIntervalMs: 1_000,
	batchMs: 400,
	/** Lines per interjection by default; FLUSH_MAX_LINES is the ceiling. */
	flushLines: 20,
	flushMaxLines: 50,
	flushMaxBytes: 8 * 1024,
	maxEvents: 100,
	/** Injected bytes per monitor. */
	maxBytes: 64 * 1024,
	/** Injected bytes across all monitors in a session. */
	sessionMaxBytes: 256 * 1024,
	/** Buffered-but-undelivered bytes across all monitors. */
	pendingMaxBytes: 64 * 1024,
	maxMonitors: 8,
	minWakeIntervalMs: 5_000,
	maxConsecutiveWakes: 8,
	ringSize: 20,
	killGraceMs: 3_000,
	stopDeadlineMs: 5_000,
	pollOutputMaxBytes: 64 * 1024,
} as const;
