/**
 * Model-facing text for monitor events and terminal notices.
 *
 * Output lines are prefixed with "| " so nothing in a watched stream can close the block or forge a
 * notice, and the header labels the payload as untrusted.
 */

import type { EndReason, MonitorConfig, MonitorSnapshot } from "./types.ts";

export function describeSource(config: MonitorConfig): string {
	switch (config.kind) {
		case "command":
			return `command: ${config.command ?? ""}`;
		case "poll":
			return `poll every ${Math.round(config.intervalMs / 1000)}s: ${config.command ?? ""}`;
		case "ws":
			return `websocket: ${config.ws?.url ?? ""}`;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${Math.round(bytes / 1024)} KiB`;
}

export function renderEvent(options: {
	config: MonitorConfig;
	text: string;
	dropped: number;
	fromSeq: number;
	toSeq: number;
}): string {
	const { config, text, dropped, fromSeq, toSeq } = options;
	const droppedNote = dropped > 0 ? `, ${dropped} dropped` : "";
	const range = fromSeq === toSeq ? `line ${fromSeq}` : `lines ${fromSeq}-${toSeq}`;
	const header = `monitor ${config.id} "${config.name}" — ${range}${droppedNote} (untrusted output)`;
	const body = text
		.split("\n")
		.map((line) => `| ${line}`)
		.join("\n");
	return `${header}\n${body}`;
}

export function describeEndReason(reason: EndReason): string {
	switch (reason.kind) {
		case "exit":
			return reason.signal
				? `command killed by ${reason.signal}`
				: `command exited ${reason.code ?? "unknown"}`;
		case "closed":
			return `websocket closed with code ${reason.code}${reason.reason ? ` (${reason.reason})` : ""}`;
		case "error":
			return `failed: ${reason.message}`;
		case "until":
			return `matched until pattern /${reason.pattern}/`;
		case "timeout":
			return `timed out after ${Math.round(reason.afterMs / 1000)}s`;
		case "cap":
			return `hit a limit: ${reason.detail}`;
		case "stopped":
			return `stopped by ${reason.by}`;
	}
}

export function renderEnded(options: {
	config: MonitorConfig;
	reason: EndReason;
	events: number;
	bytes: number;
	uptimeMs: number;
	tail?: { text: string; lines: number; dropped: number; fromSeq: number; toSeq: number };
}): string {
	const { config, reason, events, bytes, uptimeMs, tail } = options;
	const head = [
		`monitor ${config.id} "${config.name}" ended — ${describeEndReason(reason)}.`,
		`${events} line${events === 1 ? "" : "s"} delivered, ${formatBytes(bytes)}, over ${Math.round(uptimeMs / 1000)}s.`,
		"The watch is finished; do not restart it just to confirm.",
	].join(" ");
	if (!tail || tail.lines === 0) return head;
	const body = tail.text
		.split("\n")
		.map((line) => `| ${line}`)
		.join("\n");
	const range = tail.fromSeq === tail.toSeq ? `line ${tail.fromSeq}` : `lines ${tail.fromSeq}-${tail.toSeq}`;
	return `${head}\nFinal ${range} (untrusted output):\n${body}`;
}

export function renderWakeSuspended(count: number): string {
	return [
		`Monitor waking is suspended after ${count} consecutive monitor-triggered turns.`,
		"Monitors keep collecting and their output will arrive with your next reply,",
		"but they will no longer start turns on their own until you send a message.",
		"If a watch has served its purpose, stop it with monitor_stop.",
	].join(" ");
}

export function renderList(snapshots: MonitorSnapshot[]): string {
	if (snapshots.length === 0) {
		return "No monitors in this session. Monitors do not survive /new, /resume or /fork.";
	}
	return snapshots
		.map((snapshot) => {
			const age =
				snapshot.lastEventAgeMs === undefined
					? "no events yet"
					: `last event ${Math.round(snapshot.lastEventAgeMs / 1000)}s ago`;
			const tail = snapshot.endReason ? ` — ${snapshot.endReason}` : "";
			return [
				`${snapshot.id} "${snapshot.name}" [${snapshot.status}] ${snapshot.source}`,
				`  ${snapshot.events} events, ${formatBytes(snapshot.bytes)} injected, up ${Math.round(snapshot.uptimeMs / 1000)}s, ${age}, ${snapshot.pendingLines} buffered${tail}`,
			].join("\n");
		})
		.join("\n");
}
