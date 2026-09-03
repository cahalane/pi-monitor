/**
 * Monitor registry: owns monitor lifecycle, buffering, turn-aware delivery and budgets.
 *
 * Delivery rules that matter (pi semantics, see docs/extensions.md pi.sendMessage):
 *  - `steer` arrives after the current assistant turn finishes all its tool calls, before the next
 *    LLM call. It does not interrupt a running tool.
 *  - `followUp` waits until the agent has no tool calls left.
 *  - `triggerTurn` only starts a run when the agent is idle.
 *
 * So "one notification per monitor in flight" is enforced against turn boundaries: once a message is
 * sent, further lines coalesce in the buffer until `turn_end`/`agent_settled` shows the agent has
 * moved on. That is the backpressure; `sendMessage` itself is a synchronous queue insert.
 */

import { renderEnded, renderEvent, renderWakeSuspended } from "./format.ts";
import { describeSource } from "./format.ts";
import { type Batch, buildBatch, LineFilter } from "./pipeline.ts";
import { createSource, type Source, type SourceCallbacks } from "./sources.ts";
import {
	DEFAULTS,
	type DeliverAs,
	type EndReason,
	type MonitorConfig,
	type MonitorSnapshot,
	type MonitorStatus,
} from "./types.ts";

export interface OutboundMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: Record<string, unknown>;
}

export interface RegistryHooks {
	send(message: OutboundMessage, options: { deliverAs: DeliverAs; triggerTurn: boolean }): void;
	/** Called whenever a snapshot changes so the host can refresh its widget. */
	onChange(): void;
	/** Out-of-band user-facing warning; never reaches the model. */
	warn(text: string): void;
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** Overridable for tests; defaults to the real command/poll/websocket sources. */
	createSource?(config: MonitorConfig, callbacks: SourceCallbacks): Source;
}

interface Runtime {
	config: MonitorConfig;
	source: Source;
	filter: LineFilter;
	status: MonitorStatus;
	buffer: string[];
	bufferBytes: number;
	droppedFromBuffer: number;
	flushHandle: unknown;
	timeoutHandle: unknown;
	/** A message was sent and no turn boundary has passed since. */
	outstanding: boolean;
	events: number;
	bytes: number;
	startedAt: number;
	lastEventAt: number | undefined;
	endedAt: number | undefined;
	endReason: EndReason | undefined;
	pendingEnd: EndReason | undefined;
	ring: string[];
	generation: number;
	/** Monotonic count of accepted lines, so event headers can be checked for gaps. */
	seq: number;
	/** Sequence number of the first line currently buffered. */
	bufferFromSeq: number;
}

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

export class MonitorRegistry {
	private readonly hooks: RegistryHooks;
	private readonly monitors = new Map<string, Runtime>();
	private sequence = 0;
	private generation = 0;
	private shuttingDown = false;
	private sessionBytes = 0;
	private wakeOutstanding = false;
	private consecutiveWakes = 0;
	private lastWakeAt = 0;
	private hasWoken = false;
	private wakeSuspended = false;

	constructor(hooks: RegistryHooks) {
		this.hooks = hooks;
	}

	nextId(): string {
		this.sequence += 1;
		return `mon_${this.sequence}`;
	}

	liveCount(): number {
		let count = 0;
		for (const runtime of this.monitors.values()) {
			if (runtime.status !== "ended") count += 1;
		}
		return count;
	}

	async start(config: MonitorConfig): Promise<MonitorSnapshot> {
		if (this.shuttingDown) throw new Error("Session is shutting down; not starting new monitors");
		if (this.liveCount() >= DEFAULTS.maxMonitors) {
			throw new Error(
				`Already watching ${DEFAULTS.maxMonitors} things. Stop one with monitor_stop before starting another.`,
			);
		}
		if (this.sessionBytes >= DEFAULTS.sessionMaxBytes) {
			throw new Error(
				"This session has spent its whole monitor output budget " +
					`(${Math.round(DEFAULTS.sessionMaxBytes / 1024)} KiB). Summarise what you have instead of watching more.`,
			);
		}

		const runtime: Runtime = {
			config,
			filter: new LineFilter({
				match: config.match,
				ignore: config.ignore,
				dedupe: config.dedupe,
			}),
			source: undefined as unknown as Source,
			status: "running",
			buffer: [],
			bufferBytes: 0,
			droppedFromBuffer: 0,
			flushHandle: undefined,
			timeoutHandle: undefined,
			outstanding: false,
			events: 0,
			bytes: 0,
			startedAt: this.hooks.now(),
			lastEventAt: undefined,
			endedAt: undefined,
			endReason: undefined,
			pendingEnd: undefined,
			ring: [],
			generation: this.generation,
			seq: 0,
			bufferFromSeq: 1,
		};
		runtime.source = (this.hooks.createSource ?? createSource)(config, {
			onLine: (line) => this.onLine(runtime, line),
			onEnd: (reason) => {
				void this.stopRuntime(runtime, reason, { notify: true });
			},
		});
		this.monitors.set(config.id, runtime);

		try {
			await runtime.source.start();
		} catch (error) {
			this.monitors.delete(config.id);
			throw error;
		}

		if (!config.persistent && config.timeoutMs > 0) {
			runtime.timeoutHandle = this.hooks.setTimer(() => {
				void this.stopRuntime(runtime, { kind: "timeout", afterMs: config.timeoutMs }, { notify: true });
			}, config.timeoutMs);
		}
		this.hooks.onChange();
		return this.snapshot(runtime);
	}

	private onLine(runtime: Runtime, raw: string): void {
		if (runtime.generation !== this.generation || this.shuttingDown) return;
		if (runtime.status === "ended") return;
		const line = runtime.filter.accept(raw);
		if (line === undefined) return;

		runtime.ring.push(line);
		if (runtime.ring.length > DEFAULTS.ringSize) runtime.ring.shift();
		if (runtime.buffer.length === 0) runtime.bufferFromSeq = runtime.seq + 1;
		runtime.seq += 1;
		runtime.buffer.push(line);
		runtime.bufferBytes += byteLength(line) + 1;
		runtime.lastEventAt = this.hooks.now();

		this.enforcePendingBudget();

		if (runtime.config.until && runtime.filter.test(runtime.config.until)) {
			runtime.pendingEnd = { kind: "until", pattern: runtime.config.until.source };
			this.flush(runtime);
			return;
		}
		this.scheduleFlush(runtime);
		this.hooks.onChange();
	}

	/** Drops the oldest buffered lines when undelivered output grows past the global cap. */
	private enforcePendingBudget(): void {
		let total = 0;
		for (const runtime of this.monitors.values()) total += runtime.bufferBytes;
		if (total <= DEFAULTS.pendingMaxBytes) return;

		const ordered = [...this.monitors.values()].sort((a, b) => b.bufferBytes - a.bufferBytes);
		for (const runtime of ordered) {
			while (total > DEFAULTS.pendingMaxBytes && runtime.buffer.length > 1) {
				const dropped = runtime.buffer.shift();
				if (dropped === undefined) break;
				const size = byteLength(dropped) + 1;
				runtime.bufferBytes -= size;
				total -= size;
				runtime.droppedFromBuffer += 1;
			}
			if (total <= DEFAULTS.pendingMaxBytes) break;
		}
	}

	private scheduleFlush(runtime: Runtime, delayMs?: number): void {
		if (runtime.flushHandle !== undefined) return;
		const delay =
			delayMs ??
			(runtime.outstanding ? Math.min(Math.max(runtime.config.batchMs * 2, 1_000), 5_000) : runtime.config.batchMs);
		runtime.flushHandle = this.hooks.setTimer(() => {
			runtime.flushHandle = undefined;
			this.flush(runtime);
		}, delay);
	}

	/** Called on turn boundaries: the previous notification has been consumed. */
	onTurnBoundary(): void {
		this.wakeOutstanding = false;
		for (const runtime of this.monitors.values()) {
			runtime.outstanding = false;
			if (runtime.buffer.length > 0 && runtime.status !== "ended") this.scheduleFlush(runtime);
		}
	}

	/** Called when the user speaks: monitor-driven turn chains are no longer consecutive. */
	onUserTurn(): void {
		this.consecutiveWakes = 0;
		if (this.wakeSuspended) {
			this.wakeSuspended = false;
			this.hooks.onChange();
		}
	}

	private takeBatch(runtime: Runtime): Batch {
		const limits = {
			maxLines: Math.min(DEFAULTS.flushMaxLines, Math.max(DEFAULTS.flushLines, 1)),
			maxBytes: DEFAULTS.flushMaxBytes,
		};
		const batch = buildBatch(runtime.buffer, limits);
		const carriedDrops = runtime.droppedFromBuffer;
		runtime.buffer = [];
		runtime.bufferBytes = 0;
		runtime.droppedFromBuffer = 0;
		return { ...batch, dropped: batch.dropped + carriedDrops };
	}

	private flush(runtime: Runtime): void {
		if (runtime.generation !== this.generation || this.shuttingDown) return;
		if (runtime.status === "ended") return;
		if (runtime.buffer.length === 0) {
			if (runtime.pendingEnd) void this.stopRuntime(runtime, runtime.pendingEnd, { notify: true });
			return;
		}
		// Wait for the model to consume the previous notification instead of stacking messages.
		if (runtime.outstanding && !runtime.pendingEnd) {
			this.scheduleFlush(runtime);
			return;
		}
		if (runtime.pendingEnd) {
			void this.stopRuntime(runtime, runtime.pendingEnd, { notify: true });
			return;
		}

		const wake = this.decideWake(runtime.config);
		if (wake === "defer") {
			// Sending now would queue a message with nothing to wake the agent, so hold the buffer
			// until the wake interval has elapsed.
			const waitMs = Math.max(DEFAULTS.minWakeIntervalMs - (this.hooks.now() - this.lastWakeAt), 50);
			this.scheduleFlush(runtime, waitMs);
			return;
		}

		const fromSeq = runtime.bufferFromSeq;
		const toSeq = runtime.seq;
		const batch = this.takeBatch(runtime);
		if (batch.included === 0) return;
		const content = renderEvent({
			config: runtime.config,
			text: batch.text,
			dropped: batch.dropped,
			fromSeq,
			toSeq,
		});
		const size = byteLength(content);

		if (wake === "wake") this.commitWake();
		this.hooks.send(
			{
				customType: "monitor-event",
				content,
				display: true,
				details: {
					monitorId: runtime.config.id,
					name: runtime.config.name,
					kind: runtime.config.kind,
					lines: batch.included,
					dropped: batch.dropped,
					fromSeq,
					toSeq,
				},
			},
			{
				deliverAs: !runtime.config.wake ? "nextTurn" : runtime.config.deliverAs,
				triggerTurn: wake === "wake",
			},
		);

		runtime.outstanding = true;
		runtime.events += batch.included;
		runtime.bytes += size;
		this.sessionBytes += size;
		this.hooks.onChange();

		if (runtime.events >= runtime.config.maxEvents) {
			void this.stopRuntime(
				runtime,
				{ kind: "cap", detail: `${runtime.config.maxEvents} events delivered` },
				{ notify: true },
			);
			return;
		}
		if (runtime.bytes >= runtime.config.maxBytes) {
			void this.stopRuntime(
				runtime,
				{ kind: "cap", detail: `${Math.round(runtime.config.maxBytes / 1024)} KiB injected` },
				{ notify: true },
			);
			return;
		}
		if (this.sessionBytes >= DEFAULTS.sessionMaxBytes) {
			this.stopAllForBudget();
		}
	}

	/**
	 * Decides whether this delivery may start a turn.
	 *
	 * "wake" starts a turn. "none" sends without one, which is safe only when the message will be
	 * consumed anyway — waking is off, or another wake is already outstanding. "defer" means hold the
	 * output: sending it now would leave it queued with nothing to pick it up.
	 */
	private decideWake(config: MonitorConfig): "wake" | "none" | "defer" {
		if (!config.wake || config.deliverAs === "nextTurn") return "none";
		if (this.wakeSuspended || this.wakeOutstanding) return "none";
		const now = this.hooks.now();
		if (this.hasWoken && now - this.lastWakeAt < DEFAULTS.minWakeIntervalMs) return "defer";
		return "wake";
	}

	/**
	 * Records a wake and, once monitor-driven turns have chained too long, suspends waking so a
	 * monitor watching the agent's own side effects cannot loop forever.
	 */
	private commitWake(): void {
		this.wakeOutstanding = true;
		this.lastWakeAt = this.hooks.now();
		this.hasWoken = true;
		this.consecutiveWakes += 1;
		if (this.consecutiveWakes >= DEFAULTS.maxConsecutiveWakes) {
			this.wakeSuspended = true;
			this.hooks.send(
				{
					customType: "monitor-notice",
					content: renderWakeSuspended(this.consecutiveWakes),
					display: true,
					details: { reason: "wake-suspended", consecutiveWakes: this.consecutiveWakes },
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		}
	}

	private stopAllForBudget(): void {
		for (const runtime of this.monitors.values()) {
			if (runtime.status === "ended") continue;
			void this.stopRuntime(
				runtime,
				{ kind: "cap", detail: "session monitor output budget exhausted" },
				{ notify: true },
			);
		}
	}

	private async stopRuntime(
		runtime: Runtime,
		reason: EndReason,
		options: { notify: boolean },
	): Promise<void> {
		if (runtime.status === "ended" || runtime.status === "stopping") return;
		runtime.status = "stopping";
		if (runtime.flushHandle !== undefined) this.hooks.clearTimer(runtime.flushHandle);
		if (runtime.timeoutHandle !== undefined) this.hooks.clearTimer(runtime.timeoutHandle);
		runtime.flushHandle = undefined;
		runtime.timeoutHandle = undefined;
		runtime.pendingEnd = undefined;

		try {
			await runtime.source.stop();
		} catch (error) {
			this.hooks.warn(
				`monitor ${runtime.config.id} did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		runtime.status = "ended";
		runtime.endedAt = this.hooks.now();
		runtime.endReason = reason;

		const tailFromSeq = runtime.bufferFromSeq;
		const tailToSeq = runtime.seq;
		const taken = runtime.buffer.length > 0 ? this.takeBatch(runtime) : undefined;
		const tail = taken
			? { text: taken.text, lines: taken.included, dropped: taken.dropped, fromSeq: tailFromSeq, toSeq: tailToSeq }
			: undefined;
		const shouldNotify =
			options.notify && !this.shuttingDown && runtime.generation === this.generation;
		if (shouldNotify) {
			const content = renderEnded({
				config: runtime.config,
				reason,
				events: runtime.events + (tail?.lines ?? 0),
				bytes: runtime.bytes,
				uptimeMs: (runtime.endedAt ?? 0) - runtime.startedAt,
				tail,
			});
			const size = byteLength(content);
			runtime.bytes += size;
			this.sessionBytes += size;
			// A terminal notice is one-off and worth a turn, so the wake interval does not defer it.
			const wake = this.decideWake(runtime.config) !== "none";
			if (wake) this.commitWake();
			this.hooks.send(
				{
					customType: "monitor-ended",
					content,
					display: true,
					details: {
						monitorId: runtime.config.id,
						name: runtime.config.name,
						reason,
						events: runtime.events,
					},
				},
				// Keep terminal notices with their event queue. Non-waking monitors use nextTurn so
				// an asynchronous notice cannot be appended inside an in-flight tool turn.
				{
					deliverAs: !runtime.config.wake ? "nextTurn" : runtime.config.deliverAs,
					triggerTurn: wake,
				},
			);
			runtime.outstanding = true;
		}
		this.hooks.onChange();
	}

	async stop(id: string, by: "tool" | "command"): Promise<MonitorSnapshot> {
		const runtime = this.monitors.get(id);
		if (!runtime) throw new Error(`No monitor with id ${id}`);
		if (runtime.status === "ended") return this.snapshot(runtime);
		await this.stopRuntime(runtime, { kind: "stopped", by }, { notify: false });
		return this.snapshot(runtime);
	}

	async stopAll(by: "tool" | "command"): Promise<MonitorSnapshot[]> {
		const live = [...this.monitors.values()].filter((runtime) => runtime.status !== "ended");
		await Promise.all(live.map((runtime) => this.stopRuntime(runtime, { kind: "stopped", by }, { notify: false })));
		return live.map((runtime) => this.snapshot(runtime));
	}

	/** Shutdown path: no model-facing notices, and every runtime is invalidated by generation. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.generation += 1;
		const runtimes = [...this.monitors.values()];
		this.monitors.clear();
		await Promise.all(
			runtimes.map(async (runtime) => {
				if (runtime.flushHandle !== undefined) this.hooks.clearTimer(runtime.flushHandle);
				if (runtime.timeoutHandle !== undefined) this.hooks.clearTimer(runtime.timeoutHandle);
				runtime.flushHandle = undefined;
				runtime.timeoutHandle = undefined;
				runtime.status = "ended";
				try {
					await runtime.source.stop();
				} catch (error) {
					this.hooks.warn(
						`monitor ${runtime.config.id} did not stop cleanly on shutdown: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}),
		);
		this.sessionBytes = 0;
		this.wakeOutstanding = false;
		this.wakeSuspended = false;
		this.consecutiveWakes = 0;
		this.shuttingDown = false;
	}

	snapshot(runtime: Runtime): MonitorSnapshot {
		const now = this.hooks.now();
		return {
			id: runtime.config.id,
			name: runtime.config.name,
			kind: runtime.config.kind,
			source: describeSource(runtime.config),
			status: runtime.status,
			events: runtime.events,
			bytes: runtime.bytes,
			uptimeMs: (runtime.endedAt ?? now) - runtime.startedAt,
			lastEventAgeMs: runtime.lastEventAt === undefined ? undefined : now - runtime.lastEventAt,
			pendingLines: runtime.buffer.length,
			endReason: runtime.endReason ? describeEnd(runtime.endReason) : undefined,
		};
	}

	snapshots(): MonitorSnapshot[] {
		return [...this.monitors.values()].map((runtime) => this.snapshot(runtime));
	}

	isWakeSuspended(): boolean {
		return this.wakeSuspended;
	}

	sessionBytesUsed(): number {
		return this.sessionBytes;
	}
}

function describeEnd(reason: EndReason): string {
	// Kept local to avoid importing the model-facing renderer for UI text.
	switch (reason.kind) {
		case "exit":
			return reason.signal ? `killed (${reason.signal})` : `exited ${reason.code ?? "?"}`;
		case "closed":
			return `closed ${reason.code}`;
		case "error":
			return `error: ${reason.message}`;
		case "until":
			return "until matched";
		case "timeout":
			return "timed out";
		case "cap":
			return `capped (${reason.detail})`;
		case "stopped":
			return `stopped by ${reason.by}`;
	}
}
