/**
 * Pure line-processing helpers for the monitor extension.
 *
 * Everything here is deterministic and free of pi/node coupling so it can be unit tested with
 * `node --test --experimental-strip-types`.
 */

export interface LineFilterOptions {
	/** Only lines matching this regex become events. */
	match?: RegExp;
	/** Lines matching this regex are dropped, applied after `match`. */
	ignore?: RegExp;
	/** Drop a line when it is identical to the previous accepted line. */
	dedupe?: boolean;
	/** Hard cap per line; longer lines keep the tail and gain a marker. */
	maxLineChars?: number;
}

export const DEFAULT_MAX_LINE_CHARS = 2000;

/** Removes terminal control sequences while retaining ordinary text (including tabs). */
export function stripAnsi(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code === 0x1b) {
			const next = text[i + 1];
			if (next === "[") {
				// CSI ends at its first final byte (0x40-0x7e), including malformed CSI.
				i += 2;
				while (i < text.length && (text.charCodeAt(i) < 0x40 || text.charCodeAt(i) > 0x7e)) i += 1;
				continue;
			}
			if (next === "]") {
				// OSC is terminated by BEL or by the two-byte ST sequence ESC\\.
				i += 2;
				while (i < text.length && text[i] !== "\u0007" && !(text[i] === "\u001b" && text[i + 1] === "\\")) i += 1;
				if (text[i] === "\u001b") i += 1;
				continue;
			}
			// Ordinary two-byte ESC sequences and a lone ESC have no useful text.
			if (next !== undefined) i += 1;
			continue;
		}
		// C0 controls are not useful in an injected line. Keep horizontal tab for readable tables.
		if (code < 0x20 || code === 0x7f) {
			if (code === 0x09) out += text[i];
			continue;
		}
		out += text[i];
	}
	return out;
}

/** Splits a chunk into complete lines, returning the trailing partial line as `carry`. */
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
	const combined = carry + chunk.replace(/\r\n?/g, "\n");
	const parts = combined.split("\n");
	const nextCarry = parts.pop() ?? "";
	return { lines: parts, carry: nextCarry };
}

/** Truncates the head of an over-long line, keeping the tail where fresh output lives. */
export function clampLine(line: string, maxChars = DEFAULT_MAX_LINE_CHARS): string {
	if (line.length <= maxChars) return line;
	const kept = line.slice(line.length - maxChars);
	return `[${line.length - maxChars} chars elided] ${kept}`;
}

/** Stateful because dedupe needs to remember the previous accepted line. */
export class LineFilter {
	private previous: string | undefined;
	private readonly options: LineFilterOptions;

	constructor(options: LineFilterOptions = {}) {
		this.options = options;
	}

	private lastNormalized: string | undefined;

	/** Returns the displayed line to emit, or undefined when it is filtered out. */
	accept(raw: string): string | undefined {
		const max = this.options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
		const stripped = stripAnsi(raw).replace(/\s+$/, "");
		// Regexes see only the bounded tail; the display retains an honest marker based on the
		// complete ANSI-free line.
		const line = stripped.length > max ? stripped.slice(-max) : stripped;
		this.lastNormalized = undefined;
		if (line.trim().length === 0) return undefined;
		const test = (pattern: RegExp): boolean => {
			pattern.lastIndex = 0;
			return pattern.test(line);
		};
		if (this.options.match && !test(this.options.match)) return undefined;
		if (this.options.ignore && test(this.options.ignore)) return undefined;
		if (this.options.dedupe && line === this.previous) return undefined;
		this.previous = line;
		this.lastNormalized = line;
		return clampLine(stripped, max);
	}

	/** Tests a stop pattern against the same bounded, ANSI-free text used by filters. */
	test(pattern: RegExp): boolean {
		if (this.lastNormalized === undefined) return false;
		pattern.lastIndex = 0;
		return pattern.test(this.lastNormalized);
	}
}

export interface BatchLimits {
	maxLines: number;
	maxBytes: number;
}

export interface Batch {
	text: string;
	included: number;
	dropped: number;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
	return encoder.encode(value).length;
}

/**
 * Assembles buffered lines into one payload under both limits, eliding from the middle so the
 * first lines (context) and the last lines (most recent) both survive.
 */
export function buildBatch(lines: string[], limits: BatchLimits): Batch {
	if (lines.length === 0) return { text: "", included: 0, dropped: 0 };

	// Compose from a keep-count rather than splicing in place: the marker counts towards the byte
	// budget but not towards the kept lines, so removing a line must not add one back.
	const compose = (keep: number): Batch => {
		const dropped = lines.length - keep;
		if (dropped <= 0) return { text: lines.join("\n"), included: lines.length, dropped: 0 };
		const head = Math.min(Math.ceil(keep / 3), keep - 1);
		const tail = keep - head;
		const parts = [...lines.slice(0, head), `… ${dropped} lines elided …`, ...lines.slice(lines.length - tail)];
		return { text: parts.join("\n"), included: keep, dropped };
	};

	let keep = Math.min(lines.length, Math.max(1, limits.maxLines));
	let batch = compose(keep);
	while (byteLength(batch.text) > limits.maxBytes && keep > 1) {
		keep -= 1;
		batch = compose(keep);
	}
	if (byteLength(batch.text) > limits.maxBytes) {
		batch = { ...batch, text: truncateToBytes(batch.text, limits.maxBytes) };
	}
	return batch;
}

/** Trims a string to a byte budget without leaving a split multi-byte character behind. */
export function truncateToBytes(text: string, maxBytes: number): string {
	let out = text;
	while (out.length > 0 && byteLength(out) > maxBytes) {
		const step = Math.max(1, Math.ceil((byteLength(out) - maxBytes) / 4));
		out = out.slice(0, Math.max(0, out.length - step));
	}
	return out;
}

/** Compiles a user-supplied pattern, with a clear error instead of a raw SyntaxError. */
export function compilePattern(pattern: string | undefined, field: string): RegExp | undefined {
	if (pattern === undefined || pattern === "") return undefined;
	// Deliberately heuristic: catch the common catastrophic backtracking shapes without
	// rejecting useful expressions. This is a guard, not a complete regex analyser.
	const quantifier = "(?:[+*]|\\{\\d+(?:,\\d*)?\\})";
	const nested = new RegExp(`\\([^()]*${quantifier}[^()]*\\)${quantifier}`).test(pattern);
	const overlapping = [...pattern.matchAll(/\(([^()]+)\)([+*]|\{\d+(?:,\d*)?\})/g)].some((match) => {
		const alternatives = (match[1] ?? "").split("|").filter((part) => part.length > 0);
		return alternatives.some((left) => alternatives.some((right) => left !== right &&
			(left.startsWith(right) || right.startsWith(left))));
	});
	if (nested || overlapping) {
		throw new Error(`${field} pattern may cause catastrophic backtracking; simplify or bound it: /${pattern}/`);
	}
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new Error(
			`${field} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
