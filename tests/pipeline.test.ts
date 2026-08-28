import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatch, clampLine, DEFAULT_MAX_LINE_CHARS, LineFilter, splitLines } from "../pipeline.ts";

test("splitLines carries a partial line across chunk boundaries", () => {
	const first = splitLines("", "hello wor");
	assert.deepEqual(first.lines, []);
	assert.equal(first.carry, "hello wor");

	const second = splitLines(first.carry, "ld\nfoo\nbar");
	assert.deepEqual(second.lines, ["hello world", "foo"]);
	assert.equal(second.carry, "bar");
});

test("splitLines normalises \\r\\n and lone \\r to \\n", () => {
	const { lines, carry } = splitLines("", "a\r\nb\rc\n");
	assert.deepEqual(lines, ["a", "b", "c"]);
	assert.equal(carry, "");
});

test("clampLine leaves lines at or under the limit untouched", () => {
	const atLimit = "x".repeat(10);
	assert.equal(clampLine(atLimit, 10), atLimit);
});

test("clampLine elides the head of an over-long line, keeping the tail", () => {
	const line = `${"a".repeat(5)}${"b".repeat(10)}`;
	const clamped = clampLine(line, 10);
	assert.equal(clamped, `[5 chars elided] ${"b".repeat(10)}`);
});

test("clampLine falls back to the default max when unspecified", () => {
	const line = "z".repeat(DEFAULT_MAX_LINE_CHARS + 3);
	const clamped = clampLine(line);
	assert.match(clamped, /^\[3 chars elided\] /);
});

test("LineFilter applies ignore after match, even when both match", () => {
	const filter = new LineFilter({ match: /foo/, ignore: /bar/ });
	assert.equal(filter.accept("foo baz"), "foo baz");
	assert.equal(filter.accept("foo bar"), undefined);
	assert.equal(filter.accept("just bar"), undefined);
});

test("LineFilter dedupe drops only consecutive duplicates", () => {
	const filter = new LineFilter({ dedupe: true });
	assert.equal(filter.accept("a"), "a");
	assert.equal(filter.accept("a"), undefined);
	assert.equal(filter.accept("b"), "b");
	assert.equal(filter.accept("a"), "a");
});

test("LineFilter drops blank lines", () => {
	const filter = new LineFilter();
	assert.equal(filter.accept("   "), undefined);
	assert.equal(filter.accept(""), undefined);
	assert.equal(filter.accept("\t"), undefined);
});

test("buildBatch keeps everything under both limits", () => {
	const lines = ["one", "two", "three"];
	const batch = buildBatch(lines, { maxLines: 10, maxBytes: 1024 });
	assert.equal(batch.text, "one\ntwo\nthree");
	assert.equal(batch.included, 3);
	assert.equal(batch.dropped, 0);
});

test("buildBatch elides the middle when over maxLines", () => {
	const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
	const batch = buildBatch(lines, { maxLines: 9, maxBytes: 1024 * 1024 });
	const rendered = batch.text.split("\n");
	assert.equal(rendered.length, 10); // head(3) + marker + tail(6)
	assert.deepEqual(rendered.slice(0, 3), ["line-0", "line-1", "line-2"]);
	assert.equal(rendered[3], "… 11 lines elided …");
	assert.deepEqual(rendered.slice(4), ["line-14", "line-15", "line-16", "line-17", "line-18", "line-19"]);
	assert.equal(batch.dropped, 11);
	assert.equal(batch.included, 9);
	assert.equal(batch.included + batch.dropped, lines.length);
});

test("buildBatch enforces maxBytes against multi-byte UTF-8 content", () => {
	// Each euro sign is 1 char but 3 bytes in UTF-8, so a char-based limit would not bind here.
	const lines = Array.from({ length: 10 }, () => "€".repeat(20)); // 20 chars, 60 bytes each
	const limits = { maxLines: 100, maxBytes: 100 };
	const batch = buildBatch(lines, limits);
	const encoder = new TextEncoder();
	assert.ok(encoder.encode(batch.text).length <= limits.maxBytes);
	assert.ok(batch.dropped > 0);
	assert.equal(batch.included + batch.dropped, lines.length);
});

test("buildBatch on empty input returns an empty batch", () => {
	const batch = buildBatch([], { maxLines: 10, maxBytes: 1024 });
	assert.deepEqual(batch, { text: "", included: 0, dropped: 0 });
});
