/**
 * Unified Edit Extension — vendored from mitsuhiko/agent-stuff
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/unified-edit.ts
 * Upstream commit pinned at vendoring: 13bc8f87970bec8830aab0f1c0487d35aa7c0917 (2026-08-10).
 * Upstream history (3 commits, no upstream tests; context-row semantics were 1 day old at
 * vendoring): 274fe04 initial "experimental" tool, 4b00c54 rendering alignment,
 * c77d497 context rows + @@ hunks + empty-fuzzy-needle hang fix.
 * License: Apache-2.0 (see LICENSE). Vendored with local modifications (marked
 * "// LOCAL (...):" at each changed site): column-0 file headers, parse-time
 * rejection of bare "-" rows / stray "@@" / context rows under anchor ops, typed
 * match errors with block-level diagnostics, update drift guard, guarded
 * transaction-wide queued dry run, confirmed-write rollback, doc alignment.
 * Re-vendor by diffing against the pinned commit and keeping the LOCAL markers.
 */

/**
 * Unified Edit Extension — replaces the built-in `edit` tool.
 *
 * The tool accepts one text payload in the process-selected dialect: rows,
 * Codex/apply-patch, sandboxed code, pi JSON, or OMP-compatible hash lines.
 * Diff rendering uses pi's exported
 * generateDiffString/generateUnifiedPatch; the fuzzy edit matcher core is
 * inlined from pi's internal edit-diff implementation because it is not part of
 * pi's public API (and this copy adds whole-line matching on top).
 */

import {
	generateDiffString,
	generateUnifiedPatch,
	renderDiff,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, hyperlink, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { constants, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isUtf8 } from "node:buffer";
import { access, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import {
	HashSnapshotStore,
	buildHashChanges,
	formatHashReadResult,
	parseHashPayload,
	recordAppliedHashChanges,
} from "./hash-edit.ts";

// LOCAL (0.2.0): the extension ships five edit modes (row script, apply-patch,
// code, pi-native JSON, OMP-compatible hash lines) and exactly ONE is active
// per process, selected by PI_UNIFIED_EDIT_MODE
// (rows | patch | code | pi | hash, default patch). The model
// only ever sees the active mode's prompt and payload dialect — no format
// choice, so no ambiguity.
type EditMode = "rows" | "patch" | "code" | "pi" | "hash";

function getEditMode(): EditMode {
	const mode = process.env.PI_UNIFIED_EDIT_MODE?.trim().toLowerCase();
	if (mode === "rows" || mode === "code" || mode === "pi" || mode === "hash") return mode;
	if (mode === "hashline") return "hash";
	return "patch";
}

const ROWS_DESCRIPTION = `Edit files with one marked row edit script. Multiple [path] sections per call; all-or-nothing.

Format:
[path]
@OP
+inserted row
-deleted row

Headers start in column 0; an indented "[...]" row is an @REPLACE context row. Content rows are marked; to write a literal row starting with +, -, @ or [, keep the marker and repeat the char: ++plus, --minus, +@at, +[bracket. Every row must have a marker.

Operations:
@REPLACE     replace the - block with the + block that directly follows it. Space-prefixed context rows (exactly one leading space) anchor the hunk; + rows after a context row insert AFTER it. @@ separates hunks. Matching: whole-line, exact first, then fuzzy (trailing whitespace ignored; curly quotes, dashes and unicode spaces normalized; leading and internal whitespace exact). A leading space after a row marker is a diff-style separator: on exact-match failure the op is re-read with one space stripped from every -/+/context row — keep one style per op. The -/+ block must be unique; overlap is rejected; a - row must not be empty.
@INS.PRE N    insert + rows before 1-based line N
@INS.POST N   insert + rows after 1-based line N
@INS.BEFORE   insert + rows before the - anchor block
@INS.AFTER    insert + rows after the - anchor block
@APPEND       append + rows at the end
@DEL N-M      delete lines N..M (aliases: N..M, N..=M, N.=M; @DEL N deletes one line)

Line-number ops apply sequentially in script order.

Examples:
[package.json]
@REPLACE
-  "version": "1.0.0",
+  "version": "1.0.1",

[src/main.ts]
@INS.AFTER
-function main() {
+  setupFoo();
@DEL 20-23
@APPEND
+
+export { foo };

Code mode (alternative): prefix the payload with \`\`\`js (or js:) and edit files with JavaScript instead of row scripts. Whitelisted synchronous APIs: readFile(path) -> string, readLines(path) -> string[], writeFile(path, content). Paths resolve against the cwd; readFile refuses non-UTF-8 files. An exception rolls back every writeFile of the call.
Example:
\`\`\`js
const s = readFile("config.ini");
writeFile("config.ini", s.replace("name = x", "name = y"));
\`\`\``;

const ROWS_SNIPPET =
	"Edit files using one marked row script ([file], @operations, + insert rows, - delete rows).";

const ROWS_GUIDELINES = [
	"1. For each change, pick the operation with the smallest unique - block: prefer @REPLACE with - then + (a + row after a context row inserts after that line, it does not replace). Add one context row only when the - block alone is ambiguous.",
	"2. Anchored ops (@INS.BEFORE/@INS.AFTER, @REPLACE with context) beat line numbers unless you just read the file; line numbers are sequential and shift as earlier ops apply.",
	"3. Copy the file's exact whitespace into your rows: fuzzy matching ignores only trailing whitespace and normalizes quotes/dashes/unicode spaces — indentation and inner spacing must match exactly. A row without the trailing spaces still matches a line that has them.",
	"4. To delete a blank line use @DEL N — an empty - row is a parse error. To delete a line starting with +, - or @, keep the - marker and repeat the char (--minus deletes -minus).",
	"5. If the tool reports a match failure it already tried the diff-style separator: re-read the file and compare whitespace/punctuation before retrying; the error names the failing block.",
	"6. Before a multi-op script, read the target file and copy each row's exact leading format (indentation; numbered items like `4.` vs bullet `- `). A single unmatched row fails the whole script — nothing is applied.",
	"7. Prefer one call for several files. The tool never creates files (@APPEND needs an existing file) and refuses non-UTF-8/binary files.",
];

const PATCH_DESCRIPTION = `Edit files with a single apply-patch payload (OpenAI/Codex unified-diff format). All-or-nothing: one unmatched hunk fails the whole patch.
Format:
*** Begin Patch
*** Add File: new.txt
+line one
+line two
*** Delete File: old.txt
*** Update File: src/main.ts
@@ -1,3 +1,3 @@
 context line (a space prefix)
-removed line
+added line
*** End Patch

Ops: *** Add File (lines prefixed +), *** Delete File, *** Update File with @@ hunks (space-prefixed context lines, - removed, + added; multiple hunks per file; @@ with trailing text is a change-context anchor that must exist before the hunk), *** Move to: (rename after an Update File), *** End of File (anchor the last hunk at the file end). Trailing empty context lines can be omitted.

Matching is deliberately lenient: exact match first, then trailing-whitespace ignored, then both-sides whitespace ignored, then common Unicode punctuation (curly quotes, en/em dashes, non-breaking spaces) normalized to ASCII. You do not need the file's exact whitespace; a hunk whose lines differ only in whitespace or typographic punctuation still applies. Context lines must be unique enough to locate the change; if a hunk fails, the error names the file and the expected lines.

The tool never creates parent directories for Add, refuses non-UTF-8 files, and reports failures without applying anything.`;

const PATCH_SNIPPET =
	"Edit files with an apply-patch payload: *** Begin Patch ... *** End Patch (Add/Delete/Update File + @@ hunks).";

const PATCH_GUIDELINES = [
	"Read the target file first and copy the exact lines into your hunk: the hunk must match the file's actual content, not what the task text implies. Guessing content leads to repeated match failures. For large files, read only the relevant lines (use the read tool's offset/limit) instead of the whole file.",
	"Always wrap the whole payload in *** Begin Patch ... *** End Patch; every content line needs a prefix (space context, - removed, + added).",
	"Prefer the smallest unique hunk: include only the context lines needed to pin the location; for a file-end append use *** End of File after the last hunk.",
	"Matching is lenient (whitespace and typographic punctuation are normalized), but the hunk must still match some region — copy the line text itself exactly.",
	"One failed hunk fails the whole patch and nothing is applied: re-read the error, fix the failing hunk, and resubmit the entire patch.",
	"Use one patch for several files; the tool never creates files it is not told to Add and refuses non-UTF-8/binary files.",
];

const CODE_DESCRIPTION = `Edit files by running TypeScript/JavaScript in a sandbox. Prefix the payload with js: (or wrap it in a \`\`\`js fence) and use the whitelisted synchronous APIs: readFile(path) -> string, readLines(path) -> string[], writeFile(path, content). Paths resolve against the cwd. readFile refuses non-UTF-8 files; writeFile creates missing files. An exception rolls back every writeFile of the call (all-or-nothing).

Example:
\`\`\`js
const s = readFile("config.ini");
writeFile("config.ini", s.replace("name = x", "name = y"));
\`\`\``;

const CODE_SNIPPET =
	"Edit files with JavaScript: js: payload using readFile/readLines/writeFile (whitelisted sandbox APIs).";

const CODE_GUIDELINES = [
	"Begin the payload with js: (or a ```js fence) and use only readFile/readLines/writeFile/console.",
	"Prefer the smallest precise string operation: read the file, transform the string, write it back.",
	"An exception rolls back every writeFile of the call — no partial edits survive a failure.",
	"The tool refuses non-UTF-8 files (readFile throws) and never exposes require/process/network.",
];

const PI_DESCRIPTION = `Edit files with a JSON payload matching pi's native edit tool: a path plus exact oldText/newText replacements.

Format (single file):
{"path": "a.txt", "edits": [{"oldText": "name = x", "newText": "name = y"}]}

For multiple files, pass an array of such objects:
[{"path": "a.txt", "edits": [{"oldText": "alpha", "newText": "ALPHA"}]}, {"path": "b.txt", "edits": [{"oldText": "beta", "newText": "BETA"}]}]

Semantics: replacements are substring-based (they do not need to cover whole lines) and match exactly first, then with the same lenient normalization as the patch mode (trailing whitespace ignored; curly quotes, dashes and unicode spaces normalized). All edits are applied in order per file; the call is all-or-nothing — one failed replacement applies nothing. The tool refuses non-UTF-8 files and never creates new files (the path must already exist).`;

const PI_SNIPPET =
	"Edit files with pi's native JSON edit payload: {\"path\": ..., \"edits\": [{\"oldText\": ..., \"newText\": ...}]}.";

const PI_GUIDELINES = [
	"Read the target file first so your oldText matches the file's actual content — guessing content leads to repeated match failures.",
	"oldText/newText are substrings: keep them small and unique; for whole-line changes include the line's exact text (a line without trailing spaces still matches a line that has them).",
	"Multiple edits to one file are applied in array order; a single failed edit fails the whole call — re-read the error and resubmit everything.",
	"One payload can edit several files (array form); the tool never creates files and refuses non-UTF-8/binary files.",
];

const HASH_DESCRIPTION = `Edit existing UTF-8 files with OMP-compatible hash lines. In hash mode, read returns a snapshot header followed by numbered rows:
[src/main.ts#A1B2]
1:const old = 1;
2:run();

Copy the exact [path#TAG] header into edit. Every line number refers to that original tagged snapshot, even when one payload has several operations.

Format:
[src/main.ts#A1B2]
PUT 1.=1:
+const value = 2;
PUT <2:
+setup();
CUT 8.=10

Operations:
PUT N.=M:   replace original lines N..M with the following + rows
PUT <N:     insert + rows before original line N
PUT >N:     insert + rows after original line N
PUT >$:     append + rows at EOF
CUT N.=M    delete original lines N..M
REM          delete the file (must be the section's only operation)
MV path      move the edited file to a new, nonexistent path

Use multiple [path#TAG] sections for an all-or-nothing multi-file edit. PUT needs one or more + rows; '+' inserts a blank row. Explicit line ranges are supported; OMP's syntax-aware N* blocks and named registers are intentionally not supported. Use write for a new file.`;

const HASH_SNIPPET =
	"Edit files with hash-anchored line operations: read [path#TAG] + N:text, then PUT/CUT/REM/MV against original line numbers.";

const HASH_GUIDELINES = [
	"Read every target first and copy its exact [path#TAG] header. Only lines shown by read may be replaced/deleted/anchored; use offset/limit for a large file.",
	"All PUT/CUT line numbers refer to the original tagged snapshot, not to results of earlier operations in the payload.",
	"Use PUT N.=M with + replacement rows, PUT <N or >N for insertion, PUT >$ for append, and CUT N.=M for deletion. Do not use N* blocks or registers.",
	"Prefer one payload with several [path#TAG] sections. One stale tag, unseen line, overlap, invalid range, or binary file rejects the entire payload with no changes.",
	"Hash edit changes existing files. Use REM to delete, MV to move to a nonexistent destination, and the write tool to create a new file.",
];

function modePrompt(mode: EditMode): { description: string; snippet: string; guidelines: string[] } {
	if (mode === "patch") return { description: PATCH_DESCRIPTION, snippet: PATCH_SNIPPET, guidelines: PATCH_GUIDELINES };
	if (mode === "code") return { description: CODE_DESCRIPTION, snippet: CODE_SNIPPET, guidelines: CODE_GUIDELINES };
	if (mode === "pi") return { description: PI_DESCRIPTION, snippet: PI_SNIPPET, guidelines: PI_GUIDELINES };
	if (mode === "hash") return { description: HASH_DESCRIPTION, snippet: HASH_SNIPPET, guidelines: HASH_GUIDELINES };
	return { description: ROWS_DESCRIPTION, snippet: ROWS_SNIPPET, guidelines: ROWS_GUIDELINES };
}

const unifiedEditSchema = {
	type: "object",
	additionalProperties: false,
	required: ["text"],
	properties: {
		text: {
			type: "string",
			description: "The edit payload in the tool's configured dialect (row script, apply-patch, js: code, pi-native JSON, or hash lines).",
		},
	},
} as any;

type UnifiedEditParams = { text: string };
type ToolContent = Array<{ type: "text"; text: string }>;

interface Edit {
	oldText: string;
	newText: string;
}

interface EditDetailsLike {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

interface UnifiedEditDetails extends EditDetailsLike {
	files: Array<{
		path: string;
		kind: PlannedFileChange["kind"];
		details: EditDetailsLike;
	}>;
}

type PlannedFileChange = {
	kind: "update" | "write" | "add" | "delete";
	path: string;
	absolutePath: string;
	oldText: string;
	newText: string;
};

type ParsedPlan = {
	mode: "rows" | "patch" | "code" | "pi" | "hash";
	code?: string;
	cwd?: string;
	changes: PlannedFileChange[];
};

type RawFileScript = {
	path: string;
	ops: RawRowOperation[];
};

type RawRowOperation =
	| { kind: "insertBefore"; line: number; rows: string[] }
	| { kind: "insertAfter"; line: number; rows: string[] }
	| { kind: "insertBeforeAnchor"; groups: RowGroup[] }
	| { kind: "insertAfterAnchor"; groups: RowGroup[] }
	| { kind: "append"; rows: string[] }
	| { kind: "delete"; startLine: number; endLine: number }
	| { kind: "replace"; groups: RowGroup[] };

type RowGroup = {
	marker: "+" | "-" | " " | "@@";
	lines: string[];
};

type PatchOperation =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; chunks: UpdateChunk[] };

type UpdateChunk = {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

type FileSnapshot = {
	path: string;
	absolutePath: string;
	original: string | null;
	current: string | null;
};

type RenderContext<TState> = {
	state: TState;
	cwd: string;
	invalidate: () => void;
	argsComplete: boolean;
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
};

type Preview = { diff: string; files: string[]; firstChangedLine?: number } | { error: string };

// LOCAL (0.1.2): preview state is keyed only to the complete-args payload.
// While args stream, no preview exists, so the call renders a stable one-line
// header; rebuilding partial payloads reset the diff on every chunk and
// collapsed/expanded the body height, erasing and redrawing every row below
// the tool call in full-screen (alt-screen) mode — visible flicker.
type UnifiedEditCallRenderComponent = Box & {
	preview?: Preview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

type UnifiedRenderState = {
	callComponent?: UnifiedEditCallRenderComponent;
};

function prepareUnifiedArguments(args: unknown): UnifiedEditParams {
	if (typeof args === "string") return { text: args };
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		for (const key of ["text", "patch", "input", "content"]) {
			const value = (args as Record<string, unknown>)[key];
			if (typeof value === "string") return { text: value };
		}
	}
	return args as UnifiedEditParams;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

// ============================================================================
// Inlined pi edit-diff matcher core, extended with whole-line matching
// ============================================================================

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyTextReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyTextReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function isWholeLineBoundary(content: string, start: number, length: number, oldText: string): boolean {
	const end = start + length;
	const startsOnBoundary = start === 0 || content[start - 1] === "\n";
	const consumesTrailingNewline = oldText.endsWith("\n");
	const endsOnBoundary = consumesTrailingNewline || end >= content.length || content[end] === "\n";
	return startsOnBoundary && endsOnBoundary;
}

function findMatchIndex(content: string, needle: string, wholeLines: boolean): number {
	if (needle.length === 0) return -1;
	let index = content.indexOf(needle);
	while (index !== -1) {
		if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) return index;
		index = content.indexOf(needle, index + 1);
	}
	return -1;
}

function fuzzyFindText(content: string, oldText: string, wholeLines: boolean): FuzzyMatchResult {
	const exactIndex = findMatchIndex(content, oldText, wholeLines);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = findMatchIndex(fuzzyContent, fuzzyOldText, wholeLines);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function findNeedleOccurrences(content: string, needle: string, wholeLines: boolean): number[] {
	if (needle.length === 0) return [];
	const positions: number[] = [];
	let index = content.indexOf(needle);
	while (index !== -1) {
		if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) positions.push(index);
		index = content.indexOf(needle, index + (wholeLines ? 1 : needle.length));
	}
	return positions;
}

function occurrenceLines(content: string, positions: number[]): number[] {
	return positions.map((pos) => {
		let line = 1;
		for (let i = 0; i < pos; i++) {
			if (content[i] === "\n") line++;
		}
		return line;
	});
}

// LOCAL (0.1.1): returns positions as well as the count so duplicate errors can
// name the occurrence lines. Lines are computed on the (possibly normalized)
// content being searched, so they are exact for exact matches and approximate
// for fuzzy matches.
function countOccurrences(content: string, oldText: string, wholeLines: boolean): { count: number; lines: number[] } {
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) {
		// Trailing-whitespace normalization can collapse a whitespace-only
		// oldText to the empty string.  Searching/counting an empty needle with
		// String#indexOf never reaches -1 once the offset passes content.length,
		// so use a literal count instead.
		const positions = findNeedleOccurrences(content, oldText, wholeLines);
		return { count: positions.length, lines: occurrenceLines(content, positions) };
	}
	const positions = findNeedleOccurrences(normalizeForFuzzyMatch(content), fuzzyOldText, wholeLines);
	return { count: positions.length, lines: occurrenceLines(content, positions) };
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	const what = totalEdits === 1 ? "the exact text" : `edits[${editIndex}]`;
	const noun = totalEdits === 1 ? "old text" : "oldText";
	return new Error(
		`Could not find ${what} in ${path}. The ${noun} did not match even after fuzzy normalization (trailing whitespace ignored; curly quotes/dashes and unicode spaces normalized; internal and leading whitespace exact). Re-read the file and check the row content.`,
	);
}

// LOCAL (0.1.1): occurrence lines added; advice made row-mode specific.
function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number, lines?: number[]): Error {
	const what = totalEdits === 1 ? "the text" : `edits[${editIndex}]`;
	const noun = totalEdits === 1 ? "The text" : "Each oldText";
	const where = lines && lines.length > 0 ? ` (occurring at lines ${lines.join(", ")} of the searched content)` : "";
	return new Error(
		`Found ${occurrences} occurrences of ${what} in ${path}${where}. ${noun} must be unique. Provide more context: extend the - block, or add space-prefixed context rows in @REPLACE to pin one occurrence.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. In row scripts this usually means the + rows equal the - rows; check for special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

// LOCAL (0.1.1): typed match error so row-op call sites can annotate failures
// with the failing block's content without regex-parsing message text.
class EditMatchError extends Error {
	editIndex: number;
	kind: "empty" | "notFound" | "duplicate" | "noChange";

	constructor(message: string, editIndex: number, kind: EditMatchError["kind"]) {
		super(message);
		this.name = "EditMatchError";
		this.editIndex = editIndex;
		this.kind = kind;
	}
}

function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
	options?: { requireWholeLines?: boolean },
): { baseContent: string; newContent: string } {
	const wholeLines = options?.requireWholeLines === true;
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new EditMatchError(getEmptyOldTextError(path, i, normalizedEdits.length).message, i, "empty");
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText, wholeLines));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText, wholeLines);
		if (!matchResult.found) {
			throw new EditMatchError(getNotFoundError(path, i, normalizedEdits.length).message, i, "notFound");
		}

		const occurrences = countOccurrences(replacementBaseContent, edit.oldText, wholeLines);
		if (occurrences.count > 1) {
			throw new EditMatchError(
				getDuplicateError(path, i, normalizedEdits.length, occurrences.count, occurrences.lines).message,
				i,
				"duplicate",
			);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyTextReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw new EditMatchError(getNoChangeError(path, normalizedEdits.length).message, -1, "noChange");
	}

	return { baseContent, newContent };
}

// ============================================================================
// Row script parsing and application
// ============================================================================

function normalizePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) throw new Error("File path cannot be empty.");
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function resolveToCwd(cwd: string, path: string): string {
	const normalized = normalizePath(path);
	return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized);
}


// LOCAL (0.1.1): strict UTF-8 read used by every file-read path. A lossy
// read (fs.readFile with "utf-8") silently replaces invalid byte sequences
// with U+FFFD, and since edits rewrite the whole file, ANY edit to a binary
// or misencoded file corrupted those bytes. Reject instead.
class NotUtf8Error extends Error {
	constructor(path: string) {
		super(
			`Could not read ${path}: file is not valid UTF-8 (contains invalid byte sequences). Refusing to edit binary or misencoded files.`,
		);
		this.name = "NotUtf8Error";
	}
}

async function readFileUtf8Strict(path: string, absolutePath: string): Promise<string> {
	const buf = await readFile(absolutePath);
	if (!isUtf8(buf)) throw new NotUtf8Error(path);
	return buf.toString("utf-8");
}

async function readExistingNormalized(path: string, absolutePath: string): Promise<string> {
	try {
		return normalizeToLF(stripBom(await readFileUtf8Strict(path, absolutePath)).text);
	} catch (err: any) {
		if (err instanceof NotUtf8Error) throw err;
		const code = err && typeof err === "object" && "code" in err ? ` (${err.code})` : "";
		throw new Error(`Could not read ${path}${code}.`);
	}
}

async function maybeReadNormalized(path: string, absolutePath: string): Promise<string | null> {
	try {
		return normalizeToLF(stripBom(await readFileUtf8Strict(path, absolutePath)).text);
	} catch (err: any) {
		if (err instanceof NotUtf8Error) throw err;
		if (err?.code === "ENOENT") return null;
		throw err;
	}
}

function splitContent(content: string): { lines: string[]; finalNewline: boolean } {
	const finalNewline = content.endsWith("\n");
	const body = finalNewline ? content.slice(0, -1) : content;
	return { lines: body.length === 0 ? [] : body.split("\n"), finalNewline };
}

function joinContent(doc: { lines: string[]; finalNewline: boolean }): string {
	const body = doc.lines.join("\n");
	return doc.finalNewline ? `${body}\n` : body;
}

function parseRowScript(text: string): RawFileScript[] {
	const lines = normalizeToLF(text).split("\n");
	const files: RawFileScript[] = [];
	let currentFile: RawFileScript | undefined;
	let currentOp: RawRowOperation | undefined;

	function finishOp() {
		if (!currentOp) return;
		if (!currentFile) throw new Error("Internal parser error: operation without file.");
		if ("rows" in currentOp && currentOp.rows.length === 0) {
			throw new Error(`${currentOp.kind} in ${currentFile.path} has no + rows.`);
		}
		if ("groups" in currentOp && currentOp.groups.length === 0) {
			const opName =
				currentOp.kind === "replace" ? "@REPLACE" : currentOp.kind === "insertBeforeAnchor" ? "@INS.BEFORE" : "@INS.AFTER";
			// LOCAL (0.1.1): actionable two-part hint.
			throw new Error(
				`${opName} in ${currentFile.path} has no + or - rows. Each @REPLACE/@INS.BEFORE/@INS.AFTER needs at least one - or + row; context-only hunks cannot locate a change. Content starting with [ must use -/+ rows (file headers start at column 0).`,
			);
		}
		currentFile.ops.push(currentOp);
		currentOp = undefined;
	}

	function requireFile(lineNumber: number): RawFileScript {
		if (!currentFile) throw new Error(`Line ${lineNumber}: expected a [filename] header before operations or rows.`);
		return currentFile;
	}

	function pushGroup(marker: RowGroup["marker"], linesToAdd: string[]): void {
		if (!currentOp || !("groups" in currentOp)) throw new Error("Internal parser error: group row without group operation.");
		if (marker === "@@") {
			currentOp.groups.push({ marker, lines: [] });
			return;
		}
		const lastGroup = currentOp.groups[currentOp.groups.length - 1];
		if (lastGroup && lastGroup.marker === marker) lastGroup.lines.push(...linesToAdd);
		else currentOp.groups.push({ marker, lines: [...linesToAdd] });
	}

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const lineNumber = i + 1;
		const trimmed = raw.trim();
		// LOCAL (0.1.1): a space-only row inside a groups op is a blank context
		// row (one marker space, empty content) and falls through to the
		// space-prefixed context branch below. True empty rows and space-only
		// rows elsewhere remain skipped separators.
		if (trimmed === "" && !(raw.startsWith(" ") && currentOp && "groups" in currentOp)) continue;

		// LOCAL (0.1.1): file headers must start at column 0. A space-prefixed
		// "[...]" row inside @REPLACE is always a context row; before this gate it
		// was parsed as a new file section (silently truncating the op, or worse,
		// appending rows to a phantom/wrong file).
		const fileMatch = raw.startsWith("[") ? /^\[(.+)]\s*$/.exec(raw) : null;
		if (fileMatch) {
			finishOp();
			currentFile = { path: normalizePath(fileMatch[1]), ops: [] };
			files.push(currentFile);
			continue;
		}

		// LOCAL (0.1.1): stray @@ rows are a parse error instead of being silently ignored.
		if (raw.startsWith("@@")) {
			if (currentOp && "groups" in currentOp) {
				pushGroup("@@", []);
				continue;
			}
			throw new Error(`Line ${lineNumber}: '@@' is only valid inside @REPLACE hunks.`);
		}

		if (raw.startsWith("@")) {
			const file = requireFile(lineNumber);
			finishOp();

			const insertMatch = /^@INS\.(PRE|POST)\s+(\d+)\s*$/i.exec(trimmed);
			if (insertMatch) {
				const line = Number(insertMatch[2]);
				if (!Number.isSafeInteger(line) || line < 1) throw new Error(`Line ${lineNumber}: insert line number must be >= 1.`);
				currentOp = insertMatch[1].toUpperCase() === "PRE"
					? { kind: "insertBefore", line, rows: [] }
					: { kind: "insertAfter", line, rows: [] };
				continue;
			}

			if (/^@INS\.BEFORE\s*$/i.test(trimmed)) {
				currentOp = { kind: "insertBeforeAnchor", groups: [] };
				continue;
			}

			if (/^@INS\.AFTER\s*$/i.test(trimmed)) {
				currentOp = { kind: "insertAfterAnchor", groups: [] };
				continue;
			}

			if (/^@APPEND\s*$/i.test(trimmed)) {
				currentOp = { kind: "append", rows: [] };
				continue;
			}

			if (/^@REPLACE\s*$/i.test(trimmed)) {
				currentOp = { kind: "replace", groups: [] };
				continue;
			}

			const delMatch = /^@DEL\s+(\d+)(?:(?:\s*-\s*|\s*\.\.=?\s*|\s*\.=\s*)(\d+))?\s*$/i.exec(trimmed);
			if (delMatch) {
				const startLine = Number(delMatch[1]);
				const endLine = delMatch[2] === undefined ? startLine : Number(delMatch[2]);
				if (startLine < 1 || endLine < startLine) throw new Error(`Line ${lineNumber}: invalid inclusive delete range ${trimmed}.`);
				file.ops.push({ kind: "delete", startLine, endLine });
				continue;
			}

			throw new Error(`Line ${lineNumber}: unknown edit operation ${trimmed}. Expected @INS.PRE, @INS.POST, @INS.BEFORE, @INS.AFTER, @REPLACE, @APPEND, or @DEL.`);
		}

		if (raw.startsWith("+") || raw.startsWith("-")) {
			requireFile(lineNumber);
			if (!currentOp) throw new Error(`Line ${lineNumber}: row appears before an operation.`);
			const marker = raw[0] as "+" | "-";
			const body = raw.slice(1);

			// LOCAL (0.1.1): an empty - row can never match (empty oldText is
			// rejected by the matcher) — fail at parse time with a clear message.
			if (marker === "-" && body === "") {
				throw new Error(
					`Line ${lineNumber}: - rows in @REPLACE/@INS.BEFORE/@INS.AFTER must not be empty. To delete a blank line, use @DEL N.`,
				);
			}

			if ("rows" in currentOp) {
				if (marker !== "+") throw new Error(`Line ${lineNumber}: ${currentOp.kind} only accepts + rows.`);
				currentOp.rows.push(body);
				continue;
			}

			if (!("groups" in currentOp)) throw new Error(`Line ${lineNumber}: unexpected row for @DEL.`);
			pushGroup(marker, [body]);
			continue;
		}

		if (raw.startsWith(" ") && currentOp && "groups" in currentOp) {
			requireFile(lineNumber);
			if (currentOp.kind === "replace") {
				pushGroup(" ", [raw.slice(1)]);
				continue;
			}
			// LOCAL (0.1.1): context rows under anchor ops were silently discarded.
			throw new Error(
				`Line ${lineNumber}: space-prefixed context rows are only supported in @REPLACE; ${
					currentOp.kind === "insertBeforeAnchor" ? "@INS.BEFORE" : "@INS.AFTER"
				} takes only - anchor rows and + insert rows.`,
			);
		}

		throw new Error(
			`Line ${lineNumber}: invalid row script line. Every non-empty row must start with [filename], @, +, -, or a space-prefixed @REPLACE context row. File headers ([path]) must start in column 0; an indented "[...]" line is only valid as an @REPLACE context row.`,
		);
	}

	finishOp();
	if (files.length === 0) throw new Error("Row edit script must contain at least one [filename] section.");
	for (const file of files) {
		if (file.ops.length === 0) throw new Error(`File section [${file.path}] has no operations.`);
	}
	return files;
}

function getContextualReplacePairs(path: string, groups: RowGroup[]): Array<{ oldLines: string[]; newLines: string[] }> {
	const hunks: RowGroup[][] = [[]];
	for (const group of groups) {
		if (group.marker === "@@") {
			if (hunks[hunks.length - 1].length > 0) hunks.push([]);
			continue;
		}
		if (group.lines.length > 0) hunks[hunks.length - 1].push(group);
	}

	const pairs: Array<{ oldLines: string[]; newLines: string[] }> = [];
	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		if (hunk.length === 0) continue;
		const oldLines: string[] = [];
		const newLines: string[] = [];
		let hasChange = false;

		for (const group of hunk) {
			if (group.marker === " ") {
				oldLines.push(...group.lines);
				newLines.push(...group.lines);
			} else if (group.marker === "-") {
				oldLines.push(...group.lines);
				hasChange = true;
			} else if (group.marker === "+") {
				newLines.push(...group.lines);
				hasChange = true;
			}
		}

		const label = hunks.length > 1 ? ` hunk ${i + 1}` : "";
		if (!hasChange) {
			// LOCAL (0.1.1): hint extended (context-only hunks cannot locate a change).
			throw new Error(
				`@REPLACE${label} in ${path} has no + or - rows. A context-only hunk cannot locate a change; add at least one - or + row (content starting with [ must use -/+ rows; file headers start at column 0).`,
			);
		}
		if (oldLines.length === 0) {
			throw new Error(`@REPLACE${label} in ${path} has + rows but no - or context rows to locate the insertion.`);
		}
		pairs.push({ oldLines, newLines });
	}

	if (pairs.length === 0) throw new Error(`@REPLACE in ${path} has no rows.`);
	return pairs;
}

// LOCAL (0.1.1): extracted so the diff-style separator variant can reuse the
// exact same pairing/validation logic on stripped groups.
function getReplacePairsFromGroups(path: string, groups: RowGroup[]): Array<{ oldLines: string[]; newLines: string[] }> {
	if (groups.length === 0) throw new Error(`@REPLACE in ${path} has no rows.`);
	if (groups.some((group) => group.marker === " " || group.marker === "@@")) return getContextualReplacePairs(path, groups);

	const changeGroups = groups as Array<RowGroup & { marker: "+" | "-" }>;
	if (changeGroups.length === 1) {
		if (changeGroups[0].marker === "-") return [{ oldLines: changeGroups[0].lines, newLines: [] }];
		throw new Error(`@REPLACE in ${path} has + rows but no - rows to locate the replacement.`);
	}

	if (changeGroups.length % 2 !== 0) {
		throw new Error(`@REPLACE in ${path} has an odd number of +/- blocks. Pair each deleted block with an inserted block.`);
	}

	const pairs: Array<{ oldLines: string[]; newLines: string[] }> = [];
	for (let i = 0; i < changeGroups.length; i += 2) {
		const a = changeGroups[i];
		const b = changeGroups[i + 1];
		if (a.marker === b.marker) throw new Error(`@REPLACE in ${path} has two adjacent ${a.marker} blocks; expected paired + and - blocks.`);
		pairs.push({ oldLines: a.marker === "-" ? a.lines : b.lines, newLines: a.marker === "+" ? a.lines : b.lines });
	}
	return pairs;
}
function getReplacePairs(path: string, op: Extract<RawRowOperation, { kind: "replace" }>): Array<{ oldLines: string[]; newLines: string[] }> {
	return getReplacePairsFromGroups(
		path,
		op.groups.filter((group) => group.marker === "@@" || group.lines.length > 0),
	);
}

// LOCAL (0.1.1): diff-style separator variant — every -/+/context line loses
// one leading space (the marker separator). The variant is only consulted when
// the exact content does not match; it is built from the raw groups so context
// provenance is preserved (context lines are stripped in BOTH the pattern and
// the replacement, so a matched region is never re-written with its separator
// space, and + rows get the same diff-style reading as - rows).
function buildStrippedPairs(path: string, op: Extract<RawRowOperation, { kind: "replace" }>): Array<{ oldLines: string[]; newLines: string[] }> | null {
	const groups = op.groups.filter((group) => group.marker === "@@" || group.lines.length > 0);
	if (groups.length === 0) return null;
	const stripped: RowGroup[] = groups.map((group) =>
		group.marker === "@@"
			? group
			: { marker: group.marker, lines: group.lines.map((line) => (line.startsWith(" ") ? line.slice(1) : line)) },
	);
	const changed = stripped.some((group, i) =>
		group.lines.length !== groups[i].lines.length ||
		group.lines.some((line, j) => line !== groups[i].lines[j]),
	);
	if (!changed) return null;
	try {
		const pairs = getReplacePairsFromGroups(path, stripped);
		// A stripped variant must never produce an empty needle (the matcher
		// rejects empty oldText); e.g. a whitespace-only - row would strip to "".
		if (pairs.some((pair) => pair.oldLines.join("\n") === "")) return null;
		return pairs;
	} catch {
		return null; // stripped form is structurally invalid — skip it
	}
}


function rowEditFromPair(pair: { oldLines: string[]; newLines: string[] }, deleteWholeRows: boolean): Edit {
	let oldText = pair.oldLines.join("\n");
	const newText = pair.newLines.join("\n");
	if (deleteWholeRows && pair.newLines.length === 0) oldText += "\n";
	return { oldText, newText };
}

// LOCAL (0.1.1): annotate match failures with the failing block's row content
// and op ordinal so the model can fix the script without re-reading the file.
// Payload is bounded (rows truncated to 80 chars, max 5 rows) and derived only
// from script text, keeping the preview/result error-equality gates stable.
function findSimilarLineFormat(content: string, needle: string): string | null {
	// Strip leading whitespace and a bullet marker, then look for the same
	// text in the file with a different leading format (indentation, numbered
	// items like "4." vs bullets). Leading whitespace is exact in matching, so
	// this is the most common fixable mismatch.
	const stripped = needle.replace(/^\s+/, "").replace(/^-\s?/, "");
	if (!stripped) return null;
	const fileLines = content.split("\n");
	if (fileLines.includes(needle)) return null;
	for (const line of content.split("\n")) {
		if (line.trim() === stripped && line !== needle) return line;
	}
	return null;
}

function annotateMatchError(
	err: unknown,
	path: string,
	opOrdinal: number,
	opName: string,
	pairs: Array<{ oldLines: string[]; newLines: string[] }>,
	content?: string,
): Error {
	const base = err instanceof Error ? err : new Error(String(err));
	if (
		!(err instanceof EditMatchError) ||
		(err.kind !== "notFound" && err.kind !== "duplicate" && err.kind !== "empty") ||
		err.editIndex < 0
	) {
		return base;
	}
	const pair = pairs[err.editIndex];
	if (!pair) return base;
	const rows = pair.oldLines.slice(0, 5).map((line) => (line.length > 80 ? `${line.slice(0, 80)}…` : line));
	const detail = rows.join(" ⏎ ");
	// LOCAL (0.1.1): when a row exists in the file with a different leading
	// format (indentation or numbered-item vs bullet), name it so the model
	// copies the exact format instead of guessing.
	let formatNote = "";
	if (content !== undefined && err.kind === "notFound") {
		for (const line of pair.oldLines) {
			const similar = findSimilarLineFormat(content, line);
			if (similar !== null) {
				formatNote = `\nNote: the file has a similar line with different leading format: ${JSON.stringify(
					similar,
				)} — copy its exact leading whitespace and markers (numbered items like "4." vs bullets).`;
				break;
			}
		}
	}
	return new Error(
		`${base.message}\nFailed ${opName} op ${opOrdinal}, block ${err.editIndex + 1}/${pairs.length}: "${detail}"${
			detail.length > 400 ? "…" : ""
		}${formatNote}\nTip: the diff-style separator (one leading space after a marker) is already tried automatically; the row still differs from the file — re-read and compare whitespace/punctuation.`,
	);
}

function applyReplaceOperation(content: string, path: string, op: Extract<RawRowOperation, { kind: "replace" }>, opOrdinal: number): string {
	const pairs = getReplacePairs(path, op);
	const hasDeletionOnly = pairs.some((pair) => pair.newLines.length === 0);
	// LOCAL (0.1.1): ordered attempts — exact whole-row form, exact row-only form
	// (deletion fallback for a last line without trailing newline), then the
	// diff-style separator variant (one leading space stripped from - and
	// context lines, + rows verbatim), with its own row-only fallback. Descend
	// only on notFound; any other error (duplicate/empty/no-change) is final.
	// Annotations always show the ORIGINAL (unstripped) pair content.
	const attempts: Edit[][] = [pairs.map((pair) => rowEditFromPair(pair, true))];
	if (hasDeletionOnly) attempts.push(pairs.map((pair) => rowEditFromPair(pair, false)));
	const strippedPairs = buildStrippedPairs(path, op);
	if (strippedPairs) {
		attempts.push(strippedPairs.map((pair) => rowEditFromPair(pair, true)));
		if (hasDeletionOnly) attempts.push(strippedPairs.map((pair) => rowEditFromPair(pair, false)));
	}
	let lastError: unknown;
	for (const edits of attempts) {
		try {
			return applyEditsToNormalizedContent(content, edits, path, { requireWholeLines: true }).newContent;
		} catch (err) {
			lastError = err;
			const isNotFound = err instanceof EditMatchError && err.kind === "notFound";
			if (!isNotFound || edits === attempts[attempts.length - 1]) {
				throw annotateMatchError(err, path, opOrdinal, "@REPLACE", pairs, content);
			}
		}
	}
	throw annotateMatchError(lastError, path, opOrdinal, "@REPLACE", pairs, content);
}

// LOCAL (0.1.1): opOrdinal threaded for block-level error attribution.
function applyAnchorInsertOperation(
	content: string,
	path: string,
	op: Extract<RawRowOperation, { kind: "insertBeforeAnchor" | "insertAfterAnchor" }>,
	opOrdinal: number,
): string {
	const opName = op.kind === "insertBeforeAnchor" ? "@INS.BEFORE" : "@INS.AFTER";
	const groups = op.groups.filter(
		(group): group is RowGroup & { marker: "+" | "-" } =>
			(group.marker === "+" || group.marker === "-") && group.lines.length > 0,
	);
	if (groups.length !== 2 || groups[0].marker === groups[1].marker) {
		throw new Error(`${opName} in ${path} must contain exactly one - anchor block and one + insert block.`);
	}
	const anchorText = (groups[0].marker === "-" ? groups[0] : groups[1]).lines.join("\n");
	const insertText = (groups[0].marker === "+" ? groups[0] : groups[1]).lines.join("\n");
	// LOCAL (0.1.1): diff-style separator tolerance for the anchor block — the
	// exact anchor is tried first, then the variant with one leading space
	// stripped per line. newText is rebuilt from the matched anchor so the
	// separator space is never written back into the file.
	const strippedAnchor = anchorText
		.split("\n")
		.map((line) => (line.startsWith(" ") ? line.slice(1) : line))
		.join("\n");
	const anchors = strippedAnchor !== anchorText ? [anchorText, strippedAnchor] : [anchorText];
	let lastError: unknown;
	for (const anchor of anchors) {
		const newText = op.kind === "insertBeforeAnchor" ? `${insertText}\n${anchor}` : `${anchor}\n${insertText}`;
		try {
			return applyEditsToNormalizedContent(content, [{ oldText: anchor, newText }], path, {
				requireWholeLines: true,
			}).newContent;
		} catch (err) {
			lastError = err;
			const isNotFound = err instanceof EditMatchError && err.kind === "notFound";
			if (!isNotFound || anchor === anchors[anchors.length - 1]) {
				throw annotateMatchError(err, path, opOrdinal, opName, [
					{ oldLines: anchorText.split("\n"), newLines: insertText.split("\n") },
				], content);
			}
		}
	}
	throw annotateMatchError(lastError, path, opOrdinal, opName, [
		{ oldLines: anchorText.split("\n"), newLines: insertText.split("\n") },
	], content);
}

function applyRowOperations(path: string, content: string, ops: RawRowOperation[]): string {
	const doc = splitContent(content);

	// LOCAL (0.1.1): 1-based ordinal of the current op within the section, used
	// to disambiguate error attribution across multiple @REPLACE/@INS ops.
	let opOrdinal = 0;
	for (const op of ops) {
		opOrdinal++;
		switch (op.kind) {
			case "insertBefore":
			case "insertAfter": {
				const index = op.kind === "insertBefore" ? op.line - 1 : op.line;
				if (index < 0 || index > doc.lines.length) {
					const opName = op.kind === "insertBefore" ? "@INS.PRE" : "@INS.POST";
					throw new Error(`${opName} ${op.line} is outside ${path}; file has ${doc.lines.length} line(s).`);
				}
				doc.lines.splice(index, 0, ...op.rows);
				if (index + op.rows.length === doc.lines.length) doc.finalNewline = true;
				break;
			}
			case "append":
				doc.lines.push(...op.rows);
				doc.finalNewline = true;
				break;
			case "delete":
				if (op.endLine > doc.lines.length) throw new Error(`@DEL ${op.startLine}-${op.endLine} is outside ${path}; file has ${doc.lines.length} line(s).`);
				doc.lines.splice(op.startLine - 1, op.endLine - op.startLine + 1);
				if (doc.lines.length === 0) doc.finalNewline = false;
				break;
			case "replace":
			case "insertBeforeAnchor":
			case "insertAfterAnchor": {
				// LOCAL (0.1.1): opOrdinal disambiguates multi-op sections in errors.
				const next = op.kind === "replace"
					? applyReplaceOperation(joinContent(doc), path, op, opOrdinal)
					: applyAnchorInsertOperation(joinContent(doc), path, op, opOrdinal);
				Object.assign(doc, splitContent(next));
				break;
			}
		}
	}

	return joinContent(doc);
}

// ============================================================================
// Plan building (shared snapshot store for row scripts and patches)
// ============================================================================

function createUpdatePlan(path: string, absolutePath: string, oldText: string, newText: string): PlannedFileChange | undefined {
	if (oldText === newText) return undefined;
	return { kind: oldText.length === 0 ? "write" : "update", path, absolutePath, oldText, newText };
}

function createSnapshotStore(cwd: string, read: (path: string, absolutePath: string) => Promise<string | null>) {
	const snapshots = new Map<string, FileSnapshot>();
	const ordered: FileSnapshot[] = [];

	return {
		async get(path: string): Promise<FileSnapshot> {
			const absolutePath = resolveToCwd(cwd, path);
			let snapshot = snapshots.get(absolutePath);
			if (!snapshot) {
				const original = await read(path, absolutePath);
				snapshot = { path, absolutePath, original, current: original };
				snapshots.set(absolutePath, snapshot);
				ordered.push(snapshot);
			}
			return snapshot;
		},
		collectChanges(noChangesError: string): PlannedFileChange[] {
			const changes: PlannedFileChange[] = [];
			for (const { path, absolutePath, original, current } of ordered) {
				if (original === current) continue;
				if (original === null && current !== null) {
					changes.push({ kind: "add", path, absolutePath, oldText: "", newText: current });
				} else if (original !== null && current === null) {
					changes.push({ kind: "delete", path, absolutePath, oldText: original, newText: "" });
				} else if (original !== null && current !== null) {
					const plan = createUpdatePlan(path, absolutePath, original, current);
					if (plan) changes.push(plan);
				}
			}
			if (changes.length === 0) throw new Error(noChangesError);
			return changes;
		},
	};
}

async function buildRowPlan(text: string, cwd: string): Promise<ParsedPlan> {
	const scripts = parseRowScript(text);
	const store = createSnapshotStore(cwd, readExistingNormalized);

	for (const script of scripts) {
		const snapshot = await store.get(script.path);
		if (snapshot.current === null) throw new Error(`Cannot edit deleted file ${script.path}.`);
		snapshot.current = applyRowOperations(script.path, snapshot.current, script.ops);
	}

	return { mode: "rows", changes: store.collectChanges("The row edit script produced no changes.") };
}

// ============================================================================
// Patch parsing/application planning
// ============================================================================

function isPatchPayload(text: string): boolean {
	const trimmed = normalizeToLF(text).trim();
	return trimmed.startsWith("*** Begin Patch") && trimmed.endsWith("*** End Patch");
}

function isPatchLikePayload(text: string): boolean {
	return normalizeToLF(text).trimStart().startsWith("*** Begin Patch");
}

function isHashLikePayload(text: string): boolean {
	return /^\s*\[[^\n\]]+#[0-9A-Fa-f]{4}\]\s*(?:\n|$)/.test(normalizeToLF(text));
}

function patchTextForPreview(text: string): string {
	const normalized = normalizeToLF(text).trimEnd();
	return normalized.endsWith("*** End Patch") ? normalized : `${normalized}\n*** End Patch`;
}

function parseUpdateChunk(lines: string[], startIndex: number, lastContentLine: number, allowMissingContext: boolean): { chunk: UpdateChunk; nextIndex: number } {
	let i = startIndex;
	let changeContext: string | undefined;
	const first = lines[i].trimEnd();

	if (first === "@@") i++;
	else if (/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@( .*)?$/.test(first)) {
		// Standard unified-diff line-range header ("@@ -1 +1 @@") — ignore it;
		// post-trained models write it out of habit and it must not be treated
		// as a context anchor (the file never contains that literal text).
		i++;
	} else if (first.startsWith("@@ ")) {
		changeContext = first.slice(3);
		i++;
	} else if (!allowMissingContext) {
		throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let parsed = 0;
	let isEndOfFile = false;

	while (i <= lastContentLine) {
		const raw = lines[i];
		const trimmed = raw.trimEnd();
		if (trimmed === "*** End of File") {
			if (parsed === 0) throw new Error("Update hunk does not contain any lines");
			isEndOfFile = true;
			i++;
			break;
		}
		if (parsed > 0 && (trimmed.startsWith("@@") || trimmed.startsWith("*** "))) break;
		if (raw.length === 0) {
			oldLines.push("");
			newLines.push("");
			parsed++;
			i++;
			continue;
		}

		const marker = raw[0];
		const body = raw.slice(1);
		if (marker === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === "-") oldLines.push(body);
		else if (marker === "+") newLines.push(body);
		else if (parsed === 0) throw new Error(`Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`);
		else break;
		parsed++;
		i++;
	}

	if (parsed === 0) throw new Error("Update hunk does not contain any lines");
	return { chunk: { changeContext, oldLines, newLines, isEndOfFile }, nextIndex: i };
}

function parsePatch(patchText: string): PatchOperation[] {
	const lines = normalizeToLF(patchText).trim().split("\n");
	if (lines.length < 2) throw new Error("Patch is empty or invalid");
	if (lines[0].trim() !== "*** Begin Patch") throw new Error("The first line of the patch must be '*** Begin Patch'");
	if (lines[lines.length - 1].trim() !== "*** End Patch") throw new Error("The last line of the patch must be '*** End Patch'");

	const operations: PatchOperation[] = [];
	let i = 1;
	const lastContentLine = lines.length - 2;
	while (i <= lastContentLine) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}
		const line = lines[i].trim();
		if (line.startsWith("*** Add File: ")) {
			const path = normalizePath(line.slice("*** Add File: ".length));
			i++;
			const contentLines: string[] = [];
			while (i <= lastContentLine) {
				const next = lines[i];
				if (next.trim().startsWith("*** ")) break;
				if (!next.startsWith("+")) throw new Error(`Invalid add-file line '${next}'. Add file lines must start with '+'`);
				contentLines.push(next.slice(1));
				i++;
			}
			operations.push({ kind: "add", path, contents: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "" });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			operations.push({ kind: "delete", path: normalizePath(line.slice("*** Delete File: ".length)) });
			i++;
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			const path = normalizePath(line.slice("*** Update File: ".length));
			i++;
			if (i <= lastContentLine && lines[i].trim().startsWith("*** Move to: ")) throw new Error("Patch move operations (*** Move to:) are not supported.");
			const chunks: UpdateChunk[] = [];
			while (i <= lastContentLine) {
				if (lines[i].trim() === "") {
					i++;
					continue;
				}
				if (lines[i].trim().startsWith("*** ")) break;
				const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0);
				chunks.push(parsed.chunk);
				i = parsed.nextIndex;
			}
			if (chunks.length === 0) throw new Error(`Update file hunk for path '${path}' is empty`);
			operations.push({ kind: "update", path, chunks });
			continue;
		}
		throw new Error(`'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`);
	}
	return operations;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof = false): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;
	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : Math.max(0, start);
	const searchEnd = lines.length - pattern.length;
	const passes = [
		(a: string, b: string) => a === b,
		(a: string, b: string) => a.trimEnd() === b.trimEnd(),
		(a: string, b: string) => a.trim() === b.trim(),
		(a: string, b: string) => normalizeForFuzzyMatch(a).trim() === normalizeForFuzzyMatch(b).trim(),
	];
	for (const equal of passes) {
		for (let i = searchStart; i <= searchEnd; i++) {
			let ok = true;
			for (let j = 0; j < pattern.length; j++) {
				if (!equal(lines[i + j], pattern[j])) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
	}
	return undefined;
}

function deriveUpdatedContent(filePath: string, currentContent: string, chunks: UpdateChunk[]): string {
	const originalLines = currentContent.split("\n");
	if (originalLines[originalLines.length - 1] === "") originalLines.pop();
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (ctxIndex === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
			lineIndex = ctxIndex + 1;
		}
		if (chunk.oldLines.length === 0) {
			replacements.push([originalLines.length, 0, [...chunk.newLines]]);
			continue;
		}
		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}
		if (found === undefined) throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		replacements.push([found, pattern.length, [...newSlice]]);
		lineIndex = found + pattern.length;
	}

	const newLines = [...originalLines];
	for (const [start, oldLen, newSegment] of replacements.sort((a, b) => b[0] - a[0])) {
		newLines.splice(start, oldLen, ...newSegment);
	}
	if (newLines[newLines.length - 1] !== "") newLines.push("");
	return newLines.join("\n");
}

async function buildPatchPlan(text: string, cwd: string): Promise<ParsedPlan> {
	const operations = parsePatch(text);
	const store = createSnapshotStore(cwd, (_path, absolutePath) => maybeReadNormalized(_path, absolutePath));

	for (const op of operations) {
		const snapshot = await store.get(op.path);
		if (op.kind === "add") {
			const contents = normalizeToLF(op.contents);
			snapshot.current = contents.endsWith("\n") ? contents : `${contents}\n`;
			continue;
		}
		if (op.kind === "delete") {
			if (snapshot.current === null) throw new Error(`Failed to delete ${op.path}: file does not exist.`);
			snapshot.current = null;
			continue;
		}
		if (snapshot.current === null) throw new Error(`Failed to update ${op.path}: file does not exist.`);
		snapshot.current = deriveUpdatedContent(op.path, snapshot.current, op.chunks);
	}

	return { mode: "patch", changes: store.collectChanges("The patch produced no changes.") };
}

// ============================================================================
// Code mode — edit files with TypeScript/JavaScript instead of row scripts.
// Payload is prefixed with ```js (or js:). Runs in a vm sandbox with only
// readFile/readLines/writeFile/console whitelisted; an exception rolls back
// every writeFile of the call (all-or-nothing, like the row modes).
// ============================================================================

function isCodeLikePayload(text: string): boolean {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("js:")) return true;
	return /^```(?:js|javascript|ts|typescript)\s*\n[\s\S]*\n```\s*$/.test(trimmed);
}

function extractCodePayload(text: string): string {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("js:")) {
		const code = trimmed.slice(3).trim();
		if (!code) throw new Error("Code mode payload is empty after the js: prefix.");
		return code;
	}
	const m = trimmed.match(/^```(?:js|javascript|ts|typescript)\s*\n([\s\S]*?)\n```\s*$/);
	if (m && m[1].trim()) return m[1];
	throw new Error("Code mode payload is empty: expected ```js ... ``` (or js: ...) with code inside.");
}

// ============================================================================
// Pi mode — pi's native JSON edit payload: {path, edits:[{oldText,newText}]}.
// Substring replacements applied in order per file; all-or-nothing; the tool
// never creates files.
// ============================================================================

type PiEditRequest = { path: string; edits: Array<{ oldText: string; newText: string }> };

function isPiLikePayload(text: string): boolean {
	const trimmed = text.trimStart();
	// Object form, or array form that actually starts with a JSON object —
	// a bare "[" is a row-script [path] header and must not be mistaken for JSON.
	return trimmed.startsWith("{") || /^\[\s*\{/.test(trimmed);
}

async function buildPiPlan(text: string, cwd: string): Promise<ParsedPlan> {
	let requests: PiEditRequest[];
	try {
		const parsed = JSON.parse(text);
		requests = Array.isArray(parsed) ? parsed : [parsed];
	} catch (err: any) {
		throw new Error(`Pi mode: invalid JSON payload — ${err instanceof Error ? err.message : String(err)}`);
	}
	const store = createSnapshotStore(cwd, readExistingNormalized);
	for (const req of requests) {
		if (!req || typeof req.path !== "string" || !Array.isArray(req.edits) || req.edits.length === 0) {
			throw new Error('Pi mode: each entry needs a "path" string and a non-empty "edits" array.');
		}
		for (const edit of req.edits) {
			if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
				throw new Error('Pi mode: each edit needs string "oldText" and "newText".');
			}
			if (edit.oldText.length === 0) {
				throw new Error("Pi mode: oldText must not be empty — the tool never creates files.");
			}
		}
		const snapshot = await store.get(req.path);
		if (snapshot.current === null) throw new Error(`Cannot edit deleted file ${req.path}.`);
		let content = snapshot.current;
		for (const edit of req.edits) {
			content = applyEditsToNormalizedContent(content, [{ oldText: edit.oldText, newText: edit.newText }], req.path)
				.newContent;
		}
		snapshot.current = content;
	}
	return { mode: "pi", changes: store.collectChanges("The pi edit produced no changes.") };
}

type CodeWrite = {
	path: string;
	absolutePath: string;
	original: string | null; // null = file did not exist before the call
	newContent: string;
};

function buildCodePlan(text: string, cwd: string): ParsedPlan {
	const code = extractCodePayload(text);
	// Syntax-only pre-check: compile without executing (no side effects).
	try {
		vm.compileFunction(code, [], { filename: "edit-code-mode.js" });
	} catch (err: any) {
		throw new Error(
			`Code mode syntax error: ${err instanceof Error ? err.message : String(err)}\nNo changes were applied — fix the code and resubmit.`,
		);
	}
	return { mode: "code", code, cwd, changes: [] };
}

function resolveCodePath(cwd: string, path: string): string {
	if (typeof path !== "string" || path.trim() === "") throw new Error("Code mode: file path must be a non-empty string.");
	return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

async function executeCodePlan(plan: ParsedPlan & { mode: "code" }, signal?: AbortSignal): Promise<UnifiedEditDetails> {
	const code = plan.code!;
	const writes = new Map<string, CodeWrite>();
	const logs: string[] = [];

	const readFileApi = (path: string): string => {
		const abs = resolveCodePath(plan.cwd ?? "", path);
		const buf = readFileSync(abs);
		if (!isUtf8(buf)) {
			throw new Error(`Code mode: readFile("${path}") refused — the file is not valid UTF-8 (binary or misencoded files are not editable).`);
		}
		const { bom, text } = stripBom(readFileSync(abs, "utf-8"));
		return bom + text;
	};
	const readLinesApi = (path: string): string[] => readFileApi(path).split("\n");
	const writeFileApi = (path: string, content: string): void => {
		if (typeof content !== "string") throw new Error(`Code mode: writeFile("${path}", ...) requires a string content, got ${typeof content}.`);
		const abs = resolveCodePath(plan.cwd ?? "", path);
		const existing = writes.get(abs);
		if (existing) {
			existing.newContent = content;
			writeFileSync(abs, content, "utf-8");
			return;
		}
		let original: string | null = null;
		try {
			original = readFileSync(abs, "utf-8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err;
		}
		writes.set(abs, { path, absolutePath: abs, original, newContent: content });
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf-8");
	};

	const sandbox = {
		readFile: readFileApi,
		readLines: readLinesApi,
		writeFile: writeFileApi,
		console: {
			log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
			error: (...args: unknown[]) => logs.push(`error: ${args.map(String).join(" ")}`),
		},
	};
	const context = vm.createContext(sandbox);

	const rollback = (): void => {
		for (const w of writes.values()) {
			try {
				if (w.original === null) unlinkSync(w.absolutePath);
				else writeFileSync(w.absolutePath, w.original, "utf-8");
			} catch {
				// best-effort rollback; the original error is what matters
			}
		}
	};

	try {
		throwIfAborted(signal);
		vm.runInContext(code, context, { timeout: 10000, filename: "edit-code-mode.js" });
	} catch (err: any) {
		rollback();
		throw new Error(
			`Code mode failed: ${err instanceof Error ? err.message : String(err)}${
				logs.length > 0 ? `\nconsole output:\n${logs.join("\n")}` : ""
			}\nNo changes were applied — every writeFile of the call was rolled back.`,
		);
	}

	const files: UnifiedEditDetails["files"] = [];
	for (const w of writes.values()) {
		const { diff, firstChangedLine } = generateDiffString(w.original ?? "", w.newContent);
		files.push({
			path: w.path,
			kind: w.original === null ? "add" : "update",
			details: {
				diff,
				patch: generateUnifiedPatch(w.path, w.original ?? "", w.newContent),
				firstChangedLine,
			},
		});
	}
	if (files.length === 0) {
		throw new Error("Code mode made no changes: the code did not call writeFile. Call writeFile(path, content) to apply edits.");
	}
	return combineDetails(files);
}

async function buildPlanForMode(
	text: string,
	cwd: string,
	mode: EditMode,
	hashStore?: HashSnapshotStore,
): Promise<ParsedPlan> {
	if (mode === "patch") {
		if (!isPatchLikePayload(text)) {
			throw new Error(
				"This edit tool is configured for patch mode (PI_UNIFIED_EDIT_MODE=patch). Start the payload with '*** Begin Patch' and end it with '*** End Patch'.",
			);
		}
		return buildPatchPlan(text, cwd);
	}
	if (mode === "pi") {
		if (!isPiLikePayload(text)) {
			throw new Error(
				'This edit tool is configured for pi mode (PI_UNIFIED_EDIT_MODE=pi). Send a JSON payload: {"path": ..., "edits": [{"oldText": ..., "newText": ...}]}.',
			);
		}
		return buildPiPlan(text, cwd);
	}
	if (mode === "code") {
		if (!isCodeLikePayload(text)) {
			throw new Error(
				"This edit tool is configured for code mode (PI_UNIFIED_EDIT_MODE=code). Start the payload with 'js:' or a ```js fence and use readFile/readLines/writeFile.",
			);
		}
		return buildCodePlan(text, cwd);
	}
	if (mode === "hash") {
		if (!isHashLikePayload(text)) {
			throw new Error(
				"This edit tool is configured for hash mode (PI_UNIFIED_EDIT_MODE=hash). Read the target, then start each section with its exact [path#TAG] header and use PUT/CUT/REM/MV.",
			);
		}
		if (!hashStore) throw new Error("Hash mode snapshot store is unavailable; reload the extension and read the target again.");
		const changes = await buildHashChanges(text, cwd, hashStore);
		return { mode: "hash", changes };
	}
	// rows mode: reject the other dialects so the model never mixes formats
	if (isPatchLikePayload(text) || isCodeLikePayload(text) || isPiLikePayload(text) || isHashLikePayload(text)) {
		throw new Error(
			"This edit tool is configured for row-script mode (PI_UNIFIED_EDIT_MODE=rows). Use [path] sections with @REPLACE/@INS.PRE/@INS.POST/@INS.BEFORE/@INS.AFTER/@APPEND/@DEL — the payload does not start with a [filename] header.",
		);
	}
	return buildRowPlan(text, cwd);
}

// ============================================================================
// Preflight and real file mutation
// ============================================================================

async function checkCanCreatePath(absolutePath: string): Promise<void> {
	let dir = dirname(absolutePath);
	while (true) {
		try {
			await access(dir, constants.W_OK);
			return;
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err;
			const parent = dirname(dir);
			if (parent === dir) throw err;
			dir = parent;
		}
	}
}

function detailsForChange(path: string, oldText: string, newText: string): EditDetailsLike {
	const { diff, firstChangedLine } = generateDiffString(oldText, newText);
	return { diff, patch: generateUnifiedPatch(path, oldText, newText), firstChangedLine };
}

type RawFileState = { kind: "missing" } | { kind: "file"; bytes: Buffer };

type MutationFile = {
	rawBytes: Buffer;
	bom: string;
	ending: "\r\n" | "\n";
	content: string;
};

type PreparedFileChange = {
	change: PlannedFileChange;
	before: RawFileState;
	written: RawFileState;
	details: EditDetailsLike;
	output?: string;
};

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function readRawFileState(absolutePath: string): Promise<RawFileState> {
	try {
		return { kind: "file", bytes: await readFile(absolutePath) };
	} catch (error) {
		if (isMissingPathError(error)) return { kind: "missing" };
		throw error;
	}
}

function rawFileStatesEqual(a: RawFileState, b: RawFileState): boolean {
	if (a.kind !== b.kind) return false;
	return a.kind === "missing" || (b.kind === "file" && a.bytes.equals(b.bytes));
}

async function readFileForMutation(path: string, absolutePath: string): Promise<MutationFile> {
	await access(absolutePath, constants.R_OK | constants.W_OK);
	// LOCAL (0.1.1): strict UTF-8 read — never lossy-decode a file we are
	// about to rewrite (invalid bytes would be silently replaced with U+FFFD).
	const rawBytes = await readFile(absolutePath);
	if (!isUtf8(rawBytes)) throw new NotUtf8Error(path);
	const { bom, text } = stripBom(rawBytes.toString("utf-8"));
	return { rawBytes, bom, ending: detectLineEnding(text), content: normalizeToLF(text) };
}

// LOCAL (0.1.2): acquire every target queue in one stable order before the
// final dry run. This makes the dry-run snapshots and the mutations one
// transaction with respect to pi's cooperating edit/write tools. Canonical
// keys avoid self-deadlock when two path spellings resolve to the same file;
// sorting avoids lock-order deadlocks between overlapping multi-file edits.
async function mutationQueueKey(absolutePath: string): Promise<string> {
	const resolved = resolvePath(absolutePath);
	try {
		return await realpath(resolved);
	} catch (error) {
		if (isMissingPathError(error)) return resolved;
		throw error;
	}
}

async function withMutationQueues<T>(absolutePaths: string[], operation: () => Promise<T>): Promise<T> {
	const keys = [...new Set(await Promise.all(absolutePaths.map(mutationQueueKey)))].sort();
	const acquire = (index: number): Promise<T> => {
		if (index === keys.length) return operation();
		return withFileMutationQueue(keys[index], () => acquire(index + 1));
	};
	return acquire(0);
}

async function prepareFileChange(change: PlannedFileChange, signal?: AbortSignal): Promise<PreparedFileChange> {
	throwIfAborted(signal);
	if (change.kind === "add") {
		await checkCanCreatePath(change.absolutePath);
		const before = await readRawFileState(change.absolutePath);
		throwIfAborted(signal);
		if (before.kind === "file") throw new Error(`Could not add ${change.path}: file already exists.`);
		return {
			change,
			before,
			written: { kind: "file", bytes: Buffer.from(change.newText, "utf-8") },
			details: detailsForChange(change.path, "", change.newText),
			output: change.newText,
		};
	}

	const file = await readFileForMutation(change.path, change.absolutePath);
	throwIfAborted(signal);
	if (file.content !== change.oldText) {
		if (change.kind === "update") {
			throw new Error(
				`Could not edit ${change.path}: file content changed since preflight (expected ${change.oldText.length} chars, found ${file.content.length} chars). Re-read the file and retry.`,
			);
		}
		const verb = change.kind === "delete" ? "delete" : "edit";
		throw new Error(`Could not ${verb} ${change.path}: file changed since preflight.`);
	}

	const before: RawFileState = { kind: "file", bytes: file.rawBytes };
	if (change.kind === "delete") {
		return {
			change,
			before,
			written: { kind: "missing" },
			details: detailsForChange(change.path, change.oldText, ""),
		};
	}

	const output = file.bom + restoreLineEndings(change.newText, file.ending);
	return {
		change,
		before,
		written: { kind: "file", bytes: Buffer.from(output, "utf-8") },
		details: detailsForChange(change.path, file.content, change.newText),
		output,
	};
}

async function commitPreparedChange(prepared: PreparedFileChange, signal?: AbortSignal): Promise<void> {
	const { change, output } = prepared;
	throwIfAborted(signal);
	if (change.kind === "delete") {
		await unlink(change.absolutePath);
		return;
	}
	if (change.kind === "add") {
		await mkdir(dirname(change.absolutePath), { recursive: true });
		throwIfAborted(signal);
		// The final exclusive-create guard also protects against non-cooperating
		// writers racing the dry run; a collision fails without truncating them.
		await writeFile(change.absolutePath, output!, { encoding: "utf-8", flag: "wx" });
		return;
	}
	await writeFile(change.absolutePath, output!, "utf-8");
}

async function applyUpdateChange(change: PlannedFileChange, signal?: AbortSignal): Promise<EditDetailsLike> {
	return withMutationQueues([change.absolutePath], async () => {
		const prepared = await prepareFileChange(change, signal);
		await commitPreparedChange(prepared, signal);
		return prepared.details;
	});
}

// LOCAL (0.1.2): transaction-wide dry run. All target queues remain held from
// the final re-read through commit and rollback. Every target is validated and
// snapshotted before the first mutation, so drift/add collisions abort with
// zero writes. A runtime failure rolls back only commits whose filesystem call
// resolved successfully; the failing path is never guessed at or blindly
// restored. Exact Buffer comparisons keep rollback BOM/line-ending/binary
// faithful and avoid overwriting a non-cooperating concurrent writer.
async function applyPlan(plan: ParsedPlan, signal?: AbortSignal): Promise<UnifiedEditDetails> {
	if (plan.mode === "code") return executeCodePlan(plan as ParsedPlan & { mode: "code" }, signal);
	return withMutationQueues(
		plan.changes.map((change) => change.absolutePath),
		async () => {
			const prepared: PreparedFileChange[] = [];
			try {
				for (const change of plan.changes) prepared.push(await prepareFileChange(change, signal));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Preflight failed before mutating files.\n${message}`);
			}

			const applied: PreparedFileChange[] = [];
			const files: UnifiedEditDetails["files"] = [];
			try {
				for (const entry of prepared) {
					await commitPreparedChange(entry, signal);
					applied.push(entry);
					files.push({ path: entry.change.path, kind: entry.change.kind, details: entry.details });
				}
			} catch (error) {
				const rollbackErrors: string[] = [];
				for (const entry of [...applied].reverse()) {
					try {
						const current = await readRawFileState(entry.change.absolutePath);
						if (rawFileStatesEqual(current, entry.before)) continue;
						if (!rawFileStatesEqual(current, entry.written)) {
							rollbackErrors.push(`skipped restore of ${entry.change.absolutePath}: content changed after this edit`);
							continue;
						}
						if (entry.before.kind === "file") {
							await mkdir(dirname(entry.change.absolutePath), { recursive: true });
							await writeFile(entry.change.absolutePath, entry.before.bytes);
						} else if (current.kind === "file") {
							await unlink(entry.change.absolutePath);
						}
					} catch (rollbackError) {
						rollbackErrors.push(
							`rollback failed for ${entry.change.absolutePath}: ${
								rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
							}`,
						);
					}
				}

				const message = error instanceof Error ? error.message : String(error);
				const appliedPaths = applied.map((entry) => entry.change.absolutePath).join(", ");
				const suffix = [
					`Applied ${applied.length} of ${plan.changes.length} change(s) before failure${
						applied.length > 0 ? `: ${appliedPaths}` : ""
					}; rolled back confirmed changes on a best-effort basis.`,
					...rollbackErrors,
				].join("\n");
				throw new Error(`${message}\n${suffix}`);
			}

			return combineDetails(files);
		},
	);
}

function combineDetails(files: UnifiedEditDetails["files"]): UnifiedEditDetails {
	const diff = files.length === 1 ? files[0].details.diff : files.map((file) => `File: ${file.path}\n${file.details.diff}`).join("\n\n");
	const patch = files.map((file) => file.details.patch).join("\n");
	const firstChangedLine = files.find((file) => file.details.firstChangedLine !== undefined)?.details.firstChangedLine;
	return { diff, patch, firstChangedLine, files };
}

function formatSummary(details: UnifiedEditDetails): string {
	if (details.files.length === 1) {
		const file = details.files[0];
		const verb = file.kind === "add" ? "Added" : file.kind === "delete" ? "Deleted" : "Edited";
		return `${verb} ${file.path}.`;
	}
	return `Applied unified edit to ${details.files.length} file(s).\n${details.files
		.map((file, index) => `${index + 1}. ${file.kind} ${file.path}`)
		.join("\n")}`;
}

// ============================================================================
// Rendering
// ============================================================================

function previewForPlan(plan: ParsedPlan): Preview {
	if (plan.mode === "code") {
		return { diff: `Code mode — executes on submit. Writes are atomic (an exception rolls back all writeFile calls).\n\n\`\`\`js\n${plan.code}\n\`\`\``, files: [] };
	}
	const details = combineDetails(
		plan.changes.map((change) => ({
			path: change.path,
			kind: change.kind,
			details: detailsForChange(change.path, change.oldText, change.newText),
		})),
	);
	return { diff: details.diff, files: uniquePaths(plan.changes.map((change) => change.path)), firstChangedLine: details.firstChangedLine };
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	return hyperlink(styledText, pathToFileURL(resolveToCwd(cwd, rawPath)).href);
}

function renderToolPath(rawPath: string | null, theme: any, cwd: string, options?: { emptyFallback?: string }): string {
	if (rawPath === null) return theme.fg("error", "[invalid arg]");
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths));
}

function uniquePathsForCwd(paths: string[], cwd: string): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		let key = path;
		try {
			key = resolveToCwd(cwd, path);
		} catch {
			// Keep the raw path as its own key if it is still being streamed.
		}
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(path);
	}
	return unique;
}

function safeRenderablePath(path: string): string | undefined {
	try {
		return normalizePath(path);
	} catch {
		return undefined;
	}
}

function extractRowHeaderPaths(text: string): string[] {
	const paths: string[] = [];
	const lines = normalizeToLF(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		// LOCAL (0.1.1): column-0 gate, consistent with parseRowScript — a
		// space-prefixed "[...]" row inside @REPLACE is a context row, not a header.
		const complete = raw.startsWith("[") ? /^\[(.+)]\s*$/.exec(raw) : null;
		const partial = i === lines.length - 1 && raw.startsWith("[") ? /^\[([^\]]+)$/.exec(raw) : null;
		const path = safeRenderablePath(complete?.[1] ?? partial?.[1] ?? "");
		if (path) paths.push(path);
	}
	return uniquePaths(paths);
}

function extractPatchHeaderPaths(text: string): string[] {
	const paths: string[] = [];
	const prefixes = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];
	for (const raw of normalizeToLF(text).split("\n")) {
		const trimmed = raw.trim();
		for (const prefix of prefixes) {
			if (!trimmed.startsWith(prefix)) continue;
			const path = safeRenderablePath(trimmed.slice(prefix.length));
			if (path) paths.push(path);
			break;
		}
	}
	return uniquePaths(paths);
}

function extractHashHeaderPaths(text: string): string[] {
	const paths: string[] = [];
	for (const raw of normalizeToLF(text).split("\n")) {
		if (!raw.startsWith("[")) continue;
		const complete = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/.exec(raw);
		const partial = /^\[([^\]#]+)(?:#[0-9A-Fa-f]{0,4})?$/.exec(raw);
		const path = safeRenderablePath(complete?.[1] ?? partial?.[1] ?? "");
		if (path) paths.push(path);
	}
	return uniquePaths(paths);
}

// LOCAL (0.1.2): while the payload is still streaming only the cheap header
// extractors run — the full row-script/patch parse would otherwise re-run on
// every render frame, growing with the payload. The full parse matters only
// once the args are complete (the preview's files list replaces it anyway).
function getRenderablePaths(text: string | undefined, argsComplete: boolean): string[] | undefined {
	if (!text) return undefined;
	const patchLike = isPatchLikePayload(text);
	const hashLike = getEditMode() === "hash" || isHashLikePayload(text);
	const fallback = patchLike
		? extractPatchHeaderPaths(text)
		: hashLike
			? extractHashHeaderPaths(text)
			: extractRowHeaderPaths(text);
	if (!argsComplete) return fallback.length > 0 ? fallback : undefined;
	try {
		const paths = patchLike
			? parsePatch(isPatchPayload(text) ? text : patchTextForPreview(text)).map((op) => op.path)
			: hashLike
				? parseHashPayload(text).map((section) => section.path)
				: parseRowScript(text).map((script) => script.path);
		const unique = uniquePaths(paths);
		return unique.length > 0 ? unique : fallback.length > 0 ? fallback : undefined;
	} catch {
		return fallback.length > 0 ? fallback : undefined;
	}
}

function renderUnifiedPathLabel(paths: string[] | undefined, theme: any, cwd: string): string {
	const unique = paths ? uniquePathsForCwd(paths, cwd) : undefined;
	if (!unique || unique.length === 0) return renderToolPath("", theme, cwd);
	if (unique.length === 1) return renderToolPath(str(unique[0]), theme, cwd);
	return theme.fg("accent", `${unique.length} files`);
}

function formatUnifiedEditCall(text: string | undefined, preview: Preview | undefined, theme: any, cwd: string, argsComplete: boolean): string {
	const title = theme.fg("toolTitle", theme.bold("edit"));
	const paths = preview && !("error" in preview) ? preview.files : getRenderablePaths(text, argsComplete);
	return `${title} ${renderUnifiedPathLabel(paths, theme, cwd)}`;
}

function createUnifiedEditCallRenderComponent(): UnifiedEditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as Preview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getUnifiedEditCallRenderComponent(
	state: UnifiedRenderState,
	lastComponent: unknown,
): UnifiedEditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as UnifiedEditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) return state.callComponent;
	const component = createUnifiedEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getUnifiedEditHeaderBg(
	preview: Preview | undefined,
	settledError: boolean | undefined,
	theme: any,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) return (text: string) => theme.bg("toolErrorBg", text);
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolPendingBg", text);
}

function setUnifiedEditPreview(
	component: UnifiedEditCallRenderComponent,
	preview: Preview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff ||
				current.firstChangedLine !== preview.firstChangedLine ||
				current.files.join("\0") !== preview.files.join("\0")));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

function requestUnifiedEditPreview(
	component: UnifiedEditCallRenderComponent,
	text: string | undefined,
	argsKey: string | undefined,
	cwd: string,
	argsComplete: boolean,
	invalidate: () => void,
	hashStore?: HashSnapshotStore,
	mode: EditMode = getEditMode(),
): void {
	// LOCAL (0.1.2): previews are built only from complete payloads. While the
	// model is still streaming the payload every chunk changed the args key,
	// which reset the preview, then the async rebuild landed and re-expanded
	// the diff body; the resulting height oscillation rewrote every row below
	// the tool call on every chunk (flicker in full-screen mode). The built-in
	// edit gates on argsComplete too — once the payload is complete, the key is
	// stable and exactly one build+invalidate happens per payload.
	if (!argsComplete) return;
	if (!text || !argsKey || component.preview !== undefined || component.previewPending) return;

	component.previewPending = true;
	const requestKey = argsKey;
	void buildPlanForMode(text, cwd, mode, hashStore)
		.then((plan): Preview => previewForPlan(plan))
		.catch((err): Preview => ({ error: err instanceof Error ? err.message : String(err) }))
		.then((preview) => {
			if (component.previewArgsKey !== requestKey) return;
			component.previewPending = false;
			setUnifiedEditPreview(component, preview, requestKey);
			invalidate();
		});
}

function buildUnifiedEditCallComponent(
	component: UnifiedEditCallRenderComponent,
	text: string | undefined,
	theme: any,
	cwd: string,
	argsComplete: boolean,
): UnifiedEditCallRenderComponent {
	component.setBgFn(getUnifiedEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatUnifiedEditCall(text, component.preview, theme, cwd, argsComplete), 0, 0));

	if (!component.preview) return component;

	const body = "error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function formatUnifiedEditResult(
	preview: Preview | undefined,
	result: { content: ToolContent; details?: UnifiedEditDetails },
	theme: any,
	isError: boolean,
): string | undefined {
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content.map((item) => item.text || "").join("\n");
		if (!errorText || errorText === previewError) return undefined;
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) return renderDiff(resultDiff);
	return undefined;
}

export default function unifiedEditExtension(pi: ExtensionAPI) {
	const mode = getEditMode();
	const prompt = modePrompt(mode);
	const hashStore = mode === "hash" ? new HashSnapshotStore() : undefined;
	if (hashStore) {
		// LOCAL (0.2.0): hash edits need the tagged, numbered snapshot emitted by
		// OMP's read tool. Preserve pi's native read implementation/renderers and
		// transform only its successful model-facing result.
		pi.on("tool_result", async (event, ctx) => formatHashReadResult(event, ctx.cwd, hashStore));
	}
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: prompt.description,
		promptSnippet: prompt.snippet,
		promptGuidelines: prompt.guidelines,
		parameters: unifiedEditSchema,
		renderShell: "self",
		prepareArguments: prepareUnifiedArguments,

		async execute(_toolCallId, params: UnifiedEditParams, signal, _onUpdate, ctx) {
			const text = params.text;
			if (typeof text !== "string" || text.trim() === "") throw new Error("edit requires a non-empty text payload.");
			// LOCAL (0.1.1): plan-building failures (parse errors, unmatched
			// rows, non-UTF-8 targets) must state explicitly that NOTHING was
			// applied — row scripts are all-or-nothing, and models have been
			// observed to assume earlier ops in a multi-op script still landed.
			let plan: ParsedPlan;
			try {
				plan = await buildPlanForMode(text, ctx.cwd, mode, hashStore);
			} catch (err: any) {
				throw new Error(
					`${err instanceof Error ? err.message : String(err)}\nNo changes were applied — the payload is all-or-nothing: fix the failing part and resubmit the whole payload.`,
				);
			}
			const details = await applyPlan(plan, signal);
			let summary = formatSummary(details);
			if (plan.mode === "hash" && hashStore) {
				const headers = recordAppliedHashChanges(hashStore, plan.changes);
				if (headers.length > 0) summary += `\nFresh tags (re-read before another line-number edit):\n${headers.join("\n")}`;
			}
			return { content: [{ type: "text" as const, text: summary }], details };
		},

		renderCall(args, theme, context: RenderContext<UnifiedRenderState>) {
			const component = getUnifiedEditCallRenderComponent(context.state, context.lastComponent);
			const prepared = prepareUnifiedArguments(args);
			const text = prepared && typeof prepared.text === "string" ? prepared.text : undefined;
			const key = text === undefined ? undefined : `${context.cwd}\0${text}`;
			if (component.previewArgsKey !== key) {
				component.preview = undefined;
				component.previewArgsKey = key;
				component.previewPending = false;
				component.settledError = false;
			}

			requestUnifiedEditPreview(
				component,
				text,
				key,
				context.cwd,
				context.argsComplete,
				() => context.invalidate(),
				hashStore,
				mode,
			);

			return buildUnifiedEditCallComponent(component, text, theme, context.cwd, context.argsComplete);
		},

		renderResult(result, _options, theme, context: RenderContext<UnifiedRenderState>) {
			const typed = result as { content: ToolContent; details?: UnifiedEditDetails };
			const component = context.state.callComponent;
			const prepared = prepareUnifiedArguments(context.args);
			const text = prepared && typeof prepared.text === "string" ? prepared.text : undefined;
			const key = text === undefined ? undefined : `${context.cwd}\0${text}`;
			let changed = false;

			if (component) {
				if (!context.isError && typed.details?.diff) {
					changed =
						setUnifiedEditPreview(
							component,
							{
								diff: typed.details.diff,
								files: uniquePaths(typed.details.files.map((file) => file.path)),
								firstChangedLine: typed.details.firstChangedLine,
							},
							key,
						) || changed;
				}
				if (component.settledError !== context.isError) {
					component.settledError = context.isError;
					changed = true;
				}
				if (changed) buildUnifiedEditCallComponent(component, text, theme, context.cwd, context.argsComplete);
			}

			const output = formatUnifiedEditResult(component?.preview, typed, theme, context.isError);
			const resultComponent = (context.lastComponent as Container | undefined) ?? new Container();
			resultComponent.clear();
			if (!output) return resultComponent;
			resultComponent.addChild(new Spacer(1));
			resultComponent.addChild(new Text(output, 1, 0));
			return resultComponent;
		},
	});
}

// LOCAL (0.1.1): explicit test-only export surface for regression coverage.
export const __test = {
	parseRowScript,
	applyRowOperations,
	applyPlan,
	applyUpdateChange,
	applyEditsToNormalizedContent,
	parseHashPayload,
	buildHashChanges,
	formatHashReadResult,
};
