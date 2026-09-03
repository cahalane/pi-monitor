import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandSource, PollSource } from "../../sources.ts";
import type { MonitorConfig } from "../../types.ts";

const config = (kind: MonitorConfig["kind"], command: string): MonitorConfig => ({
	id: "integration",
	name: "integration",
	kind,
	command,
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

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for integration event");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

test("CommandSource streams stdout/stderr and flushes an unterminated trailing line", async () => {
	const lines: string[] = [];
	const source = new CommandSource(config("command", "printf 'out\\ntrail'; printf 'err\\n' >&2"), {
		onLine: (line) => lines.push(line),
		onEnd: () => {},
	});
	await source.start();
	await waitFor(() => lines.includes("trail") && lines.includes("err"));
	assert.deepEqual([...lines].sort(), ["err", "out", "trail"]);
	await source.stop();
});

test("PollSource emits initial output, suppresses unchanged output, marks changes, and ignores ANSI churn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-monitor-poll-"));
	const state = join(directory, "state");
	await writeFile(state, "same\n\nline");
	const lines: string[] = [];
	const source = new PollSource(
		config("poll", `printf '\\033[3%sm%s\\033[0m\\n' "$(( $(date +%s) % 2 + 1 ))" "$(cat ${state})"`),
		{ onLine: (line) => lines.push(line), onEnd: () => {} },
	);
	try {
		await source.start();
		await waitFor(() => lines.includes("same") && lines.includes("line"));
		const initialCount = lines.length;
		await new Promise((resolve) => setTimeout(resolve, 1_150));
		assert.equal(lines.length, initialCount);

		// Interior blank lines are output, not decoration, so removing one is a change.
		await writeFile(state, "same\nline");
		await waitFor(() => lines.filter((line) => line === "--- output changed ---").length === 1);

		await writeFile(state, "changed");
		await waitFor(() =>
			lines.filter((line) => line === "--- output changed ---").length === 2 && lines.includes("changed"),
		);
	} finally {
		await source.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

test("CommandSource terminates a POSIX process group including a pipeline descendant", { skip: process.platform === "win32" }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-monitor-kill-"));
	const pidFile = join(directory, "pid");
	const source = new CommandSource(config("command", `sleep 30 & echo $! > ${pidFile}; wait`), {
		onLine: () => {},
		onEnd: () => {},
	});
	try {
		await source.start();
		await waitFor(() => {
			try {
				return Number((readFileSync(pidFile, "utf8") as string).trim()) > 0;
			} catch {
				return false;
			}
		});
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		assert.ok(pid > 0);
		await source.stop();
		assert.throws(() => process.kill(pid, 0), /ESRCH|ENOENT/);
	} finally {
		await source.stop();
		await rm(directory, { recursive: true, force: true });
	}
});

