import assert from "node:assert/strict";
import { test } from "node:test";
import { MonitorRegistry } from "../registry.ts";
import type { OutboundMessage, RegistryHooks } from "../registry.ts";
import type { Source, SourceCallbacks } from "../sources.ts";
import { DEFAULTS } from "../types.ts";
import type { MonitorConfig } from "../types.ts";

/** Deterministic timer wheel: `advance(ms)` fires every timer due within the window, in order. */
class FakeClock {
	time = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { at: number; fn: () => void }>();

	now = (): number => this.time;

	setTimer = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + ms, fn });
		return id;
	};

	clearTimer = (handle: unknown): void => {
		this.timers.delete(handle as number);
	};

	/** Advances the clock, firing every timer due at or before the new time, in due-time order. */
	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			let dueId: number | undefined;
			let dueAt = Infinity;
			for (const [id, timer] of this.timers) {
				if (timer.at <= target && timer.at < dueAt) {
					dueAt = timer.at;
					dueId = id;
				}
			}
			if (dueId === undefined) break;
			const timer = this.timers.get(dueId);
			if (!timer) break;
			this.timers.delete(dueId);
			this.time = timer.at;
			timer.fn();
		}
		this.time = target;
	}
}

interface FakeSourceEntry {
	callbacks: SourceCallbacks;
	startCalls: number;
	stopCalls: number;
}

/** Records source instances and callbacks by monitor id so tests can drive them directly. */
class FakeSourceFactory {
	readonly entries = new Map<string, FakeSourceEntry>();

	create = (config: MonitorConfig, callbacks: SourceCallbacks): Source => {
		const entry: FakeSourceEntry = { callbacks, startCalls: 0, stopCalls: 0 };
		this.entries.set(config.id, entry);
		return {
			start: async () => {
				entry.startCalls += 1;
			},
			stop: async () => {
				entry.stopCalls += 1;
			},
		};
	};

	get(id: string): FakeSourceEntry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`no fake source for ${id}`);
		return entry;
	}
}

interface Harness {
	registry: MonitorRegistry;
	clock: FakeClock;
	sources: FakeSourceFactory;
	sent: Array<{ message: OutboundMessage; deliverAs: string; triggerTurn: boolean }>;
	warnings: string[];
}

function makeHarness(): Harness {
	const clock = new FakeClock();
	const sources = new FakeSourceFactory();
	const sent: Harness["sent"] = [];
	const warnings: string[] = [];
	const hooks: RegistryHooks = {
		send: (message, options) => {
			sent.push({ message, deliverAs: options.deliverAs, triggerTurn: options.triggerTurn });
		},
		onChange: () => {},
		warn: (text) => {
			warnings.push(text);
		},
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		createSource: sources.create,
	};
	return { registry: new MonitorRegistry(hooks), clock, sources, sent, warnings };
}

function config(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
	return {
		id: overrides.id ?? "mon_1",
		name: "test",
		kind: "command",
		command: "watch",
		intervalMs: DEFAULTS.intervalMs,
		timeoutMs: 0,
		persistent: true,
		dedupe: false,
		batchMs: 50,
		maxEvents: DEFAULTS.maxEvents,
		maxBytes: DEFAULTS.maxBytes,
		wake: true,
		deliverAs: "steer",
		...overrides,
	};
}

function eventsOf(harness: Harness, customType: string): Harness["sent"] {
	return harness.sent.filter((entry) => entry.message.customType === customType);
}

async function flushMicrotasks(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

test("lines arriving inside batchMs coalesce into one send", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 50 }));
	const source = h.sources.get("mon_1");
	source.callbacks.onLine("a");
	source.callbacks.onLine("b");
	source.callbacks.onLine("c");
	h.clock.advance(50);

	const events = eventsOf(h, "monitor-event");
	assert.equal(events.length, 1);
	assert.equal(events[0]?.message.details?.lines, 3);
});

test("further lines buffer without a second send until onTurnBoundary releases them", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 50 }));
	const source = h.sources.get("mon_1");

	source.callbacks.onLine("a");
	h.clock.advance(50);
	assert.equal(eventsOf(h, "monitor-event").length, 1, "first line delivered");

	source.callbacks.onLine("b");
	source.callbacks.onLine("c");
	h.clock.advance(5_000);
	assert.equal(eventsOf(h, "monitor-event").length, 1, "no second send while the first is outstanding");

	h.registry.onTurnBoundary();
	h.clock.advance(5_000);

	const events = eventsOf(h, "monitor-event");
	assert.equal(events.length, 2, "buffered lines released as a single subsequent send");
	assert.equal(events[1]?.message.details?.lines, 2);
});

test("wake gating: first wake fires, a concurrent monitor waits, and the 5s interval blocks a retry", async () => {
	const h = makeHarness();
	await h.registry.start(config({ id: "mon_1", batchMs: 0 }));
	await h.registry.start(config({ id: "mon_2", batchMs: 0 }));

	h.sources.get("mon_1").callbacks.onLine("a");
	h.clock.advance(0);
	const first = eventsOf(h, "monitor-event");
	assert.equal(first.length, 1);
	assert.equal(first[0]?.triggerTurn, true, "first wake is allowed");

	h.sources.get("mon_2").callbacks.onLine("b");
	h.clock.advance(0);
	const second = eventsOf(h, "monitor-event");
	assert.equal(second.length, 2);
	assert.equal(second[1]?.triggerTurn, false, "a wake is already outstanding");

	h.registry.onTurnBoundary();
	h.sources.get("mon_1").callbacks.onLine("c");
	h.clock.advance(0);
	assert.equal(eventsOf(h, "monitor-event").length, 2, "inside the 5s wake interval the flush is deferred, not sent");

	h.clock.advance(DEFAULTS.minWakeIntervalMs);
	const third = eventsOf(h, "monitor-event");
	assert.equal(third.length, 3, "the deferred flush lands once the interval has elapsed");
	assert.equal(third[2]?.triggerTurn, true, "and it is allowed to wake the agent");
});

test("wake suspends after maxConsecutiveWakes and onUserTurn re-arms it", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 0 }));
	const source = h.sources.get("mon_1");

	for (let i = 0; i < DEFAULTS.maxConsecutiveWakes; i++) {
		if (i > 0) h.clock.advance(DEFAULTS.minWakeIntervalMs);
		source.callbacks.onLine(`line-${i}`);
		h.clock.advance(0);
		h.registry.onTurnBoundary();
	}

	const notices = eventsOf(h, "monitor-notice");
	assert.equal(notices.length, 1, "one suspension notice after the cap is hit");
	const eventsAtCap = eventsOf(h, "monitor-event");
	assert.equal(eventsAtCap[eventsAtCap.length - 1]?.triggerTurn, true, "the wake that hits the cap still fires");

	h.clock.advance(DEFAULTS.minWakeIntervalMs);
	source.callbacks.onLine("after-cap");
	h.clock.advance(0);
	const afterCap = eventsOf(h, "monitor-event");
	assert.equal(afterCap[afterCap.length - 1]?.triggerTurn, false, "waking stays suspended");
	h.registry.onTurnBoundary();

	h.registry.onUserTurn();
	h.clock.advance(DEFAULTS.minWakeIntervalMs);
	source.callbacks.onLine("after-user-turn");
	h.clock.advance(0);
	const afterUserTurn = eventsOf(h, "monitor-event");
	assert.equal(afterUserTurn[afterUserTurn.length - 1]?.triggerTurn, true, "onUserTurn re-arms waking");
});

test("hitting maxEvents stops the monitor with a cap reason and a monitor-ended message", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 0, maxEvents: 2 }));
	const source = h.sources.get("mon_1");

	source.callbacks.onLine("a");
	source.callbacks.onLine("b");
	h.clock.advance(0);
	await flushMicrotasks();

	const ended = eventsOf(h, "monitor-ended");
	assert.equal(ended.length, 1);
	assert.deepEqual(ended[0]?.message.details?.reason, { kind: "cap", detail: "2 events delivered" });
	assert.equal(h.sources.get("mon_1").stopCalls, 1);
});

test("hitting the per-monitor maxBytes stops the monitor with a cap reason", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 0, maxBytes: 8 }));
	const source = h.sources.get("mon_1");

	source.callbacks.onLine("a line long enough to blow an 8 byte budget");
	h.clock.advance(0);
	await flushMicrotasks();

	const ended = eventsOf(h, "monitor-ended");
	assert.equal(ended.length, 1);
	const reason = ended[0]?.message.details?.reason as { kind: string; detail: string };
	assert.equal(reason.kind, "cap");
	assert.match(reason.detail, /KiB injected/);
});

test("`until` ends the watch after delivering the matching line", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 400, until: /DONE/ }));
	const source = h.sources.get("mon_1");

	source.callbacks.onLine("building");
	source.callbacks.onLine("DONE");
	await flushMicrotasks();

	assert.equal(eventsOf(h, "monitor-event").length, 0, "the matching batch is delivered via the ended notice");
	const ended = eventsOf(h, "monitor-ended");
	assert.equal(ended.length, 1);
	assert.deepEqual(ended[0]?.message.details?.reason, { kind: "until", pattern: "DONE" });
	assert.match(ended[0]?.message.content ?? "", /\| building\n\| DONE/);
	assert.equal(h.sources.get("mon_1").stopCalls, 1);
});

test("a source-reported end sends exactly one monitor-ended, and stopping an ended monitor sends no more", async () => {
	const h = makeHarness();
	await h.registry.start(config());
	const source = h.sources.get("mon_1");

	source.callbacks.onEnd({ kind: "exit", code: 0, signal: null });
	await flushMicrotasks();

	assert.equal(eventsOf(h, "monitor-ended").length, 1);
	assert.equal(source.stopCalls, 1);

	await h.registry.stop("mon_1", "tool");
	assert.equal(eventsOf(h, "monitor-ended").length, 1, "no second notice for an already-ended monitor");
	assert.equal(source.stopCalls, 1, "the source is not stopped twice");
});

test("the ended notice uses the monitor's own delivery mode so it cannot overtake a queued event", async () => {
	const h = makeHarness();
	await h.registry.start(config({ batchMs: 50, deliverAs: "steer" }));
	const source = h.sources.get("mon_1");

	source.callbacks.onLine("a");
	h.clock.advance(50);
	source.callbacks.onEnd({ kind: "exit", code: 0, signal: null });
	await flushMicrotasks();

	const ended = eventsOf(h, "monitor-ended");
	assert.equal(ended.length, 1);
	assert.equal(ended[0]?.deliverAs, "steer", "same queue as the events it summarises");
});

test("shutdown sends no model-facing messages, stops every source, and ignores a late line from a lagging source", async () => {
	const h = makeHarness();
	await h.registry.start(config({ id: "mon_1" }));
	await h.registry.start(config({ id: "mon_2" }));
	const laggingSource = h.sources.get("mon_1");

	await h.registry.shutdown();

	assert.equal(h.sent.length, 0, "shutdown is silent to the model");
	assert.equal(laggingSource.stopCalls, 1);
	assert.equal(h.sources.get("mon_2").stopCalls, 1);

	laggingSource.callbacks.onLine("too late");
	assert.equal(h.sent.length, 0, "a callback from a stale generation is ignored");
});

test("starting more than maxMonitors live monitors throws", async () => {
	const h = makeHarness();
	for (let i = 0; i < DEFAULTS.maxMonitors; i++) {
		await h.registry.start(config({ id: `mon_${i}` }));
	}
	await assert.rejects(h.registry.start(config({ id: "mon_overflow" })), /Already watching/);
});
