/*
 * Hash-line edit mode for pi-unified-edit.
 *
 * The wire format and read notation are compatible with the explicit-line
 * core of oh-my-pi's hashline tool (PUT/CUT/REM/MV and [path#TAG] anchors).
 * This is a Node-native implementation that feeds pi-unified-edit's stronger
 * transaction-wide planner; it does not copy OMP's Bun/tree-sitter engine.
 * See THIRD_PARTY_NOTICES.md for attribution and the intentionally unsupported
 * syntax-aware block/register extensions.
 */

import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

const HASH_SNAPSHOT_LIMIT_BYTES = 32 * 1024 * 1024;
const HASH_HISTORY_DEPTH = 4;

export type HashFileChange = {
	kind: "update" | "write" | "add" | "delete";
	path: string;
	absolutePath: string;
	oldText: string;
	newText: string;
};

type HashSnapshot = {
	tag: string;
	text: string;
	seenLines: Set<number>;
};

type PutRange = { kind: "putRange"; start: number; end: number; rows: string[]; sourceLine: number };
type PutAt = { kind: "putAt"; gap: "before" | "after" | "eof"; line?: number; rows: string[]; sourceLine: number };
type CutRange = { kind: "cutRange"; start: number; end: number; sourceLine: number };
type HashLineOperation = PutRange | PutAt | CutRange;

type HashSection = {
	path: string;
	tag: string;
	operations: HashLineOperation[];
	remove: boolean;
	moveTo?: string;
	headerLine: number;
};

type HashReadEvent = ToolResultEvent;
type HashReadResult = { content: ToolResultEvent["content"] };

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeHashInput(text: string): string {
	// OMP hashes normalized line endings after ignoring horizontal trailing
	// whitespace. Keeping this exact property means tags survive harmless
	// trailing-space differences while the stored snapshot still guards drift.
	return normalizeToLF(text).replace(/[ \t]+(?=\n|$)/g, "");
}

function rotl32(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function xxhRound(accumulator: number, lane: number): number {
	let value = (accumulator + Math.imul(lane, 0x85ebca77)) >>> 0;
	value = rotl32(value, 13);
	return Math.imul(value, 0x9e3779b1) >>> 0;
}

/** Pure-JS XXH32, seed 0. OMP uses the low 16 bits as four uppercase hex. */
export function xxHash32(text: string): number {
	const bytes = Buffer.from(text, "utf8");
	const length = bytes.length;
	let offset = 0;
	let hash: number;

	if (length >= 16) {
		let v1 = (0x9e3779b1 + 0x85ebca77) >>> 0;
		let v2 = 0x85ebca77;
		let v3 = 0;
		let v4 = (-0x9e3779b1) >>> 0;
		const limit = length - 16;
		do {
			v1 = xxhRound(v1, bytes.readUInt32LE(offset));
			offset += 4;
			v2 = xxhRound(v2, bytes.readUInt32LE(offset));
			offset += 4;
			v3 = xxhRound(v3, bytes.readUInt32LE(offset));
			offset += 4;
			v4 = xxhRound(v4, bytes.readUInt32LE(offset));
			offset += 4;
		} while (offset <= limit);
		hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
	} else {
		hash = 0x165667b1;
	}

	hash = (hash + length) >>> 0;
	while (offset + 4 <= length) {
		hash = (hash + Math.imul(bytes.readUInt32LE(offset), 0xc2b2ae3d)) >>> 0;
		hash = Math.imul(rotl32(hash, 17), 0x27d4eb2f) >>> 0;
		offset += 4;
	}
	while (offset < length) {
		hash = (hash + Math.imul(bytes[offset], 0x165667b1)) >>> 0;
		hash = Math.imul(rotl32(hash, 11), 0x9e3779b1) >>> 0;
		offset++;
	}
	hash ^= hash >>> 15;
	hash = Math.imul(hash, 0x85ebca77) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae3d) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

export function hashTag(text: string): string {
	return (xxHash32(normalizeHashInput(text)) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

export class HashSnapshotStore {
	private readonly histories = new Map<string, HashSnapshot[]>();

	record(absolutePath: string, text: string, seenLines: Iterable<number> = []): string {
		const path = resolvePath(absolutePath);
		const normalized = normalizeToLF(stripBom(text));
		const tag = hashTag(normalized);
		const history = this.histories.get(path) ?? [];
		const existing = history.find((entry) => entry.tag === tag && entry.text === normalized);
		if (existing) {
			for (const line of seenLines) existing.seenLines.add(line);
			this.histories.set(path, [existing, ...history.filter((entry) => entry !== existing)]);
			return tag;
		}
		const snapshot: HashSnapshot = { tag, text: normalized, seenLines: new Set(seenLines) };
		this.histories.set(path, [snapshot, ...history].slice(0, HASH_HISTORY_DEPTH));
		return tag;
	}

	find(absolutePath: string, tag: string, text: string): HashSnapshot | undefined {
		const normalized = normalizeToLF(stripBom(text));
		return this.histories
			.get(resolvePath(absolutePath))
			?.find((entry) => entry.tag === tag.toUpperCase() && entry.text === normalized);
	}

	invalidate(absolutePath: string): void {
		this.histories.delete(resolvePath(absolutePath));
	}
}

function normalizePayloadPath(path: string): string {
	let value = path.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}
	if (!value || value.includes("\0")) throw new Error("Hash mode: file paths must be non-empty and contain no NUL byte.");
	return value;
}

function absoluteFor(cwd: string, path: string): string {
	return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

function parseRange(raw: string, op: "PUT" | "CUT", sourceLine: number): { start: number; end: number } {
	const match = /^(\d+)(?:(?:\.=|\.\.|-)(\d+))?$/.exec(raw);
	if (!match) throw new Error(`Hash mode line ${sourceLine}: invalid ${op} range '${raw}'; use N.=M.`);
	const start = Number(match[1]);
	const end = Number(match[2] ?? match[1]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
		throw new Error(`Hash mode line ${sourceLine}: invalid ${op} range '${raw}'.`);
	}
	return { start, end };
}

function operationStart(raw: string): boolean {
	return /^(?:PUT|CUT|REM|MV)(?:\s|$)/.test(raw.trim());
}

export function parseHashPayload(payload: string): HashSection[] {
	const lines = normalizeToLF(payload).split("\n");
	const sections: HashSection[] = [];
	let current: HashSection | undefined;
	let index = 0;

	while (index < lines.length) {
		const raw = lines[index];
		const lineNo = index + 1;
		const header = raw.startsWith("[") ? /^\[(.+)#([0-9A-Fa-f]{4})\]\s*$/.exec(raw) : null;
		if (header) {
			current = {
				path: normalizePayloadPath(header[1]),
				tag: header[2].toUpperCase(),
				operations: [],
				remove: false,
				headerLine: lineNo,
			};
			sections.push(current);
			index++;
			continue;
		}
		if (raw.trim() === "") {
			index++;
			continue;
		}
		if (!current) {
			throw new Error(`Hash mode line ${lineNo}: expected a [path#TAG] header from the read tool.`);
		}

		const trimmed = raw.trim();
		let match: RegExpExecArray | null;
		if ((match = /^PUT\s+([^:]+):\s*$/.exec(trimmed))) {
			const anchor = match[1].trim();
			const rows: string[] = [];
			index++;
			while (index < lines.length && lines[index].startsWith("+")) {
				rows.push(lines[index].slice(1));
				index++;
			}
			if (rows.length === 0) {
				throw new Error(`Hash mode line ${lineNo}: PUT needs one or more +content rows (use '+' for a blank row).`);
			}
			if (anchor === ">$" || anchor === "$") {
				current.operations.push({ kind: "putAt", gap: "eof", rows, sourceLine: lineNo });
			} else if (/^[<>]\d+$/.test(anchor)) {
				current.operations.push({
					kind: "putAt",
					gap: anchor[0] === "<" ? "before" : "after",
					line: Number(anchor.slice(1)),
					rows,
					sourceLine: lineNo,
				});
			} else {
				const range = parseRange(anchor, "PUT", lineNo);
				current.operations.push({ kind: "putRange", ...range, rows, sourceLine: lineNo });
			}
			continue;
		}
		if ((match = /^CUT\s+([^:]+):?\s*$/.exec(trimmed))) {
			const range = parseRange(match[1].trim(), "CUT", lineNo);
			current.operations.push({ kind: "cutRange", ...range, sourceLine: lineNo });
			index++;
			continue;
		}
		if (trimmed === "REM") {
			current.remove = true;
			index++;
			continue;
		}
		if ((match = /^MV\s+(.+)$/.exec(trimmed))) {
			current.moveTo = normalizePayloadPath(match[1]);
			index++;
			continue;
		}
		if (raw.startsWith("+")) {
			throw new Error(`Hash mode line ${lineNo}: stray +content row without a preceding PUT.`);
		}
		if (operationStart(raw)) {
			throw new Error(`Hash mode line ${lineNo}: unsupported operation '${trimmed}'.`);
		}
		throw new Error(`Hash mode line ${lineNo}: expected PUT, CUT, REM, MV, or a [path#TAG] header.`);
	}

	if (sections.length === 0) throw new Error("Hash mode: payload has no [path#TAG] section.");
	for (const section of sections) {
		if (section.operations.length === 0 && !section.remove && !section.moveTo) {
			throw new Error(`Hash mode line ${section.headerLine}: section [${section.path}#${section.tag}] has no operation.`);
		}
		if (section.remove && (section.operations.length > 0 || section.moveTo)) {
			throw new Error(`Hash mode: REM must be the only operation for ${section.path}.`);
		}
	}
	return sections;
}

function splitFileLines(text: string): { lines: string[]; finalNewline: boolean } {
	if (text === "") return { lines: [], finalNewline: false };
	const finalNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (finalNewline) lines.pop();
	return { lines, finalNewline };
}

function assertLineSeen(snapshot: HashSnapshot, line: number, path: string, sourceLine: number): void {
	if (!snapshot.seenLines.has(line)) {
		throw new Error(
			`Hash mode line ${sourceLine}: ${path}:${line} was not shown by read for tag ${snapshot.tag}; read the relevant range and retry with its tag.`,
		);
	}
}

export function applyHashOperations(path: string, text: string, operations: HashLineOperation[], snapshot?: HashSnapshot): string {
	const { lines, finalNewline } = splitFileLines(normalizeToLF(text));
	const lineCount = lines.length;
	const ranges: Array<{ start: number; end: number; rows: string[]; sourceLine: number }> = [];
	const inserts = new Map<number, Array<{ rows: string[]; sourceLine: number }>>();

	for (const op of operations) {
		if (op.kind === "putRange" || op.kind === "cutRange") {
			if (op.end > lineCount) {
				throw new Error(`Hash mode line ${op.sourceLine}: range ${op.start}.=${op.end} exceeds ${path}'s ${lineCount} lines.`);
			}
			if (snapshot) {
				for (let line = op.start; line <= op.end; line++) assertLineSeen(snapshot, line, path, op.sourceLine);
			}
			ranges.push({
				start: op.start,
				end: op.end,
				rows: op.kind === "putRange" ? op.rows : [],
				sourceLine: op.sourceLine,
			});
			continue;
		}

		let gap: number;
		if (op.gap === "eof") gap = lineCount;
		else {
			const line = op.line!;
			if (line < 1 || line > lineCount) {
				throw new Error(`Hash mode line ${op.sourceLine}: line ${line} exceeds ${path}'s ${lineCount} lines.`);
			}
			if (snapshot) assertLineSeen(snapshot, line, path, op.sourceLine);
			gap = op.gap === "before" ? line - 1 : line;
		}
		const atGap = inserts.get(gap) ?? [];
		atGap.push({ rows: op.rows, sourceLine: op.sourceLine });
		inserts.set(gap, atGap);
	}

	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let index = 1; index < ranges.length; index++) {
		if (ranges[index].start <= ranges[index - 1].end) {
			throw new Error(
				`Hash mode: overlapping original-line ranges ${ranges[index - 1].start}.=${ranges[index - 1].end} and ${ranges[index].start}.=${ranges[index].end} are ambiguous.`,
			);
		}
	}
	for (const gap of inserts.keys()) {
		for (const range of ranges) {
			if (gap > range.start - 1 && gap < range.end) {
				throw new Error(`Hash mode: insertion at original-line gap ${gap} falls inside replaced range ${range.start}.=${range.end}.`);
			}
		}
	}

	const output: string[] = [];
	let line = 1;
	let rangeIndex = 0;
	while (line <= lineCount) {
		for (const insertion of inserts.get(line - 1) ?? []) output.push(...insertion.rows);
		const range = ranges[rangeIndex];
		if (range && range.start === line) {
			output.push(...range.rows);
			line = range.end + 1;
			rangeIndex++;
			continue;
		}
		output.push(lines[line - 1]);
		line++;
	}
	for (const insertion of inserts.get(lineCount) ?? []) output.push(...insertion.rows);
	if (output.length === 0) return "";
	return `${output.join("\n")}${finalNewline ? "\n" : ""}`;
}

async function readNormalizedFile(path: string, displayPath: string): Promise<string> {
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error: any) {
		if (error?.code === "ENOENT") throw new Error(`Hash mode: ${displayPath} does not exist.`);
		throw error;
	}
	if (!isUtf8(bytes)) {
		throw new Error(`Hash mode refused ${displayPath}: the file is not valid UTF-8 (binary or misencoded files are not editable).`);
	}
	return normalizeToLF(stripBom(bytes.toString("utf8")));
}

export async function buildHashChanges(payload: string, cwd: string, store: HashSnapshotStore): Promise<HashFileChange[]> {
	const parsed = parseHashPayload(payload);
	const grouped = new Map<string, HashSection>();
	for (const section of parsed) {
		const absolutePath = absoluteFor(cwd, section.path);
		const prior = grouped.get(absolutePath);
		if (!prior) {
			grouped.set(absolutePath, { ...section, operations: [...section.operations] });
			continue;
		}
		if (prior.tag !== section.tag) throw new Error(`Hash mode: ${section.path} appears with conflicting tags ${prior.tag} and ${section.tag}.`);
		if (prior.remove || section.remove || prior.moveTo || section.moveTo) {
			throw new Error(`Hash mode: REM/MV sections for ${section.path} cannot be repeated.`);
		}
		prior.operations.push(...section.operations);
	}

	const changes: HashFileChange[] = [];
	const claimedDestinations = new Set<string>();
	for (const [absolutePath, section] of grouped) {
		const current = await readNormalizedFile(absolutePath, section.path);
		const currentTag = hashTag(current);
		if (currentTag !== section.tag) {
			throw new Error(`Hash mode: stale tag for ${section.path}; payload has ${section.tag}, current file is ${currentTag}. Re-read and retry.`);
		}
		const snapshot = store.find(absolutePath, section.tag, current);
		if (!snapshot) {
			throw new Error(`Hash mode: tag ${section.tag} for ${section.path} was not issued by this session's read tool. Read the file and retry.`);
		}
		if (section.remove) {
			changes.push({ kind: "delete", path: section.path, absolutePath, oldText: current, newText: "" });
			continue;
		}
		const next = applyHashOperations(section.path, current, section.operations, snapshot);
		if (next === current && !section.moveTo) throw new Error(`Hash mode: operations for ${section.path} produced no changes.`);
		if (!section.moveTo) {
			changes.push({ kind: "update", path: section.path, absolutePath, oldText: current, newText: next });
			continue;
		}

		const destinationPath = normalizePayloadPath(section.moveTo);
		const destinationAbsolute = absoluteFor(cwd, destinationPath);
		if (destinationAbsolute === absolutePath) throw new Error(`Hash mode: MV destination for ${section.path} is the same file.`);
		if (claimedDestinations.has(destinationAbsolute) || grouped.has(destinationAbsolute)) {
			throw new Error(`Hash mode: MV destination ${destinationPath} is also targeted by another section.`);
		}
		claimedDestinations.add(destinationAbsolute);
		try {
			await readFile(destinationAbsolute);
			throw new Error(`Hash mode: MV destination ${destinationPath} already exists.`);
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
		changes.push({ kind: "delete", path: section.path, absolutePath, oldText: current, newText: "" });
		changes.push({ kind: "add", path: destinationPath, absolutePath: destinationAbsolute, oldText: "", newText: next });
	}
	if (changes.length === 0) throw new Error("Hash mode payload produced no changes.");
	return changes;
}

function displayedPath(cwd: string, requested: string, absolutePath: string): string {
	const cleaned = requested.startsWith("@") ? requested.slice(1) : requested;
	if (!isAbsolute(cleaned)) return cleaned.replaceAll("\\", "/");
	const rel = relative(cwd, absolutePath);
	if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.replaceAll("\\", "/");
	return absolutePath.replaceAll("\\", "/");
}

function splitReadFooter(text: string): { body: string; footer: string } {
	const marker = text.lastIndexOf("\n\n[");
	if (marker < 0) return { body: text, footer: "" };
	const footer = text.slice(marker + 2);
	if (!/(?:Use offset=|more lines in file|exceeds .* limit)/.test(footer)) return { body: text, footer: "" };
	return { body: text.slice(0, marker), footer: `\n\n${footer}` };
}

function noteOnTextContent(event: HashReadEvent, note: string): HashReadResult | undefined {
	let added = false;
	const content = event.content.map((item) => {
		if (added || item.type !== "text" || typeof item.text !== "string") return item;
		added = true;
		return { ...item, text: `${item.text}\n\n${note}` };
	});
	return added ? { content } : undefined;
}

/** Transform a successful built-in read result into OMP-compatible hash lines. */
export async function formatHashReadResult(
	event: HashReadEvent,
	cwd: string,
	store: HashSnapshotStore,
): Promise<HashReadResult | undefined> {
	if (event.toolName !== "read" || event.isError) return undefined;
	const input = event.input as { path?: unknown; offset?: unknown } | undefined;
	if (typeof input?.path !== "string" || input.path.trim() === "") return undefined;
	const requested = input.path.startsWith("@") ? input.path.slice(1) : input.path;
	const absolutePath = absoluteFor(cwd, requested);
	let bytes: Buffer;
	try {
		bytes = await readFile(absolutePath);
	} catch {
		return undefined;
	}
	if (bytes.length > HASH_SNAPSHOT_LIMIT_BYTES) {
		return noteOnTextContent(event, `[Hash mode: ${requested} exceeds the 32 MiB snapshot limit and cannot be hash-edited.]`);
	}
	if (!isUtf8(bytes)) {
		return noteOnTextContent(event, `[Hash mode: ${requested} is not valid UTF-8 and cannot be edited.]`);
	}

	const fullText = normalizeToLF(stripBom(bytes.toString("utf8")));
	const tag = hashTag(fullText);
	const firstTextIndex = event.content.findIndex((item) => item.type === "text");
	if (firstTextIndex < 0) return undefined;
	const firstText = event.content[firstTextIndex];
	if (firstText.type !== "text") return undefined;
	const originalOutput = firstText.text;
	if (/^\[Line \d+ is .*exceeds .*limit/.test(originalOutput)) {
		store.record(absolutePath, fullText);
		return noteOnTextContent(event, `[Hash mode: line is too large to anchor; use a smaller textual view before editing.]`);
	}
	const { body, footer } = splitReadFooter(normalizeToLF(originalOutput));
	const rows = body === "" ? [] : body.split("\n");
	if (rows.length > 0 && rows[rows.length - 1] === "" && fullText.endsWith("\n")) rows.pop();
	const rawOffset = typeof input.offset === "number" ? input.offset : 1;
	const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 1;
	const seen: number[] = [];
	const numbered = rows.map((row, index) => {
		const line = offset + index;
		seen.push(line);
		return `${line}:${row}`;
	});
	store.record(absolutePath, fullText, seen);
	const header = `[${displayedPath(cwd, requested, absolutePath)}#${tag}]`;
	const transformed = `${header}${numbered.length > 0 ? `\n${numbered.join("\n")}` : ""}${footer}`;
	const content = event.content.map((item, index) => (index === firstTextIndex ? { ...item, text: transformed } : item));
	return { content };
}

export function recordAppliedHashChanges(store: HashSnapshotStore, changes: HashFileChange[]): string[] {
	const headers: string[] = [];
	for (const change of changes) {
		if (change.kind === "delete") {
			store.invalidate(change.absolutePath);
			continue;
		}
		const tag = store.record(change.absolutePath, change.newText);
		headers.push(`[${change.path}#${tag}]`);
	}
	return headers;
}
