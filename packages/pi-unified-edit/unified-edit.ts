/**
 * Hash-only edit extension, derived from mitsuhiko/agent-stuff's unified-edit.ts
 * at 13bc8f87970bec8830aab0f1c0487d35aa7c0917 (Apache-2.0; see LICENSE).
 * See THIRD_PARTY_NOTICES.md for hashline format attribution.
 */

import {
	generateDiffString,
	generateUnifiedPatch,
	renderDiff,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, hyperlink, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { access, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	HashSnapshotStore,
	buildHashChanges,
	formatHashReadResult,
	normalizeToLF,
	recordAppliedHashChanges,
	type HashFileChange,
} from "./hash-edit.ts";

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

const unifiedEditSchema = {
	type: "object",
	additionalProperties: false,
	required: ["text"],
	properties: {
		text: {
			type: "string",
			description: "Hash-line payload with [path#TAG] sections and PUT/CUT/REM/MV operations.",
		},
	},
} as any;

type UnifiedEditParams = { text: string };
type ToolContent = Array<{ type: "text"; text: string }>;

interface EditDetailsLike {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

interface UnifiedEditDetails extends EditDetailsLike {
	files: Array<{ path: string; kind: HashFileChange["kind"]; details: EditDetailsLike }>;
}

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

type UnifiedEditCallRenderComponent = Box & {
	preview?: Preview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

type UnifiedRenderState = { callComponent?: UnifiedEditCallRenderComponent };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function normalizePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) throw new Error("File path cannot be empty.");
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function resolveToCwd(cwd: string, path: string): string {
	const normalized = normalizePath(path);
	return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized);
}

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
	change: HashFileChange;
	before: RawFileState;
	written: RawFileState;
	details: EditDetailsLike;
};

function isMissingPathError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
	return code === "ENOENT" || code === "ENOTDIR";
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
	const rawBytes = await readFile(absolutePath);
	if (!isUtf8(rawBytes)) {
		throw new Error(
			`Could not read ${path}: file is not valid UTF-8 (contains invalid byte sequences). Refusing to edit binary or misencoded files.`,
		);
	}
	const { bom, text } = splitBom(rawBytes.toString("utf-8"));
	return { rawBytes, bom, ending: detectLineEnding(text), content: normalizeToLF(text) };
}

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
	const acquire = (index: number): Promise<T> =>
		index === keys.length ? operation() : withFileMutationQueue(keys[index], () => acquire(index + 1));
	return acquire(0);
}

async function prepareFileChange(change: HashFileChange, signal?: AbortSignal): Promise<PreparedFileChange> {
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
		throw new Error(`Could not ${change.kind === "delete" ? "delete" : "edit"} ${change.path}: file changed since preflight.`);
	}

	const before: RawFileState = { kind: "file", bytes: file.rawBytes };
	if (change.kind === "delete") {
		return { change, before, written: { kind: "missing" }, details: detailsForChange(change.path, change.oldText, "") };
	}

	const output = file.bom + restoreLineEndings(change.newText, file.ending);
	return {
		change,
		before,
		written: { kind: "file", bytes: Buffer.from(output, "utf-8") },
		details: detailsForChange(change.path, file.content, change.newText),
	};
}

async function commitPreparedChange(prepared: PreparedFileChange, signal?: AbortSignal): Promise<void> {
	const { change, written } = prepared;
	throwIfAborted(signal);
	if (written.kind === "missing") {
		await unlink(change.absolutePath);
		return;
	}
	if (change.kind === "add") {
		await mkdir(dirname(change.absolutePath), { recursive: true });
		throwIfAborted(signal);
		await writeFile(change.absolutePath, written.bytes, { flag: "wx" });
		return;
	}
	await writeFile(change.absolutePath, written.bytes);
}

async function applyChanges(changes: HashFileChange[], signal?: AbortSignal): Promise<UnifiedEditDetails> {
	return withMutationQueues(
		changes.map((change) => change.absolutePath),
		async () => {
			const prepared: PreparedFileChange[] = [];
			try {
				for (const change of changes) prepared.push(await prepareFileChange(change, signal));
			} catch (error) {
				throw new Error(`Preflight failed before mutating files.\n${errorText(error)}`);
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
						rollbackErrors.push(`rollback failed for ${entry.change.absolutePath}: ${errorText(rollbackError)}`);
					}
				}

				const appliedPaths = applied.map((entry) => entry.change.absolutePath).join(", ");
				throw new Error(
					[
						errorText(error),
						`Applied ${applied.length} of ${changes.length} change(s) before failure${applied.length > 0 ? `: ${appliedPaths}` : ""}; rolled back confirmed changes on a best-effort basis.`,
						...rollbackErrors,
					].join("\n"),
				);
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

function previewForChanges(changes: HashFileChange[]): Preview {
	const details = combineDetails(
		changes.map((change) => ({
			path: change.path,
			kind: change.kind,
			details: detailsForChange(change.path, change.oldText, change.newText),
		})),
	);
	return { diff: details.diff, files: uniquePaths(changes.map((change) => change.path)), firstChangedLine: details.firstChangedLine };
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
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
	return [...new Set(paths)];
}

function uniquePathsForCwd(paths: string[], cwd: string): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		let key = path;
		try {
			key = resolveToCwd(cwd, path);
		} catch {
			// Incomplete streaming path: keep the raw spelling as its own key.
		}
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(path);
	}
	return unique;
}

function extractHashHeaderPaths(text: string): string[] {
	const paths: string[] = [];
	for (const raw of normalizeToLF(text).split("\n")) {
		if (!raw.startsWith("[")) continue;
		const complete = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/.exec(raw);
		const partial = /^\[([^\]#]+)(?:#[0-9A-Fa-f]{0,4})?$/.exec(raw);
		const candidate = complete?.[1] ?? partial?.[1] ?? "";
		try {
			if (candidate) paths.push(normalizePath(candidate));
		} catch {
			// Skip incomplete headers while arguments are still streaming.
		}
	}
	return uniquePaths(paths);
}

function renderUnifiedPathLabel(paths: string[] | undefined, theme: any, cwd: string): string {
	const unique = paths ? uniquePathsForCwd(paths, cwd) : undefined;
	if (!unique || unique.length === 0) return renderToolPath("", theme, cwd);
	if (unique.length === 1) return renderToolPath(unique[0], theme, cwd);
	return theme.fg("accent", `${unique.length} files`);
}

function formatUnifiedEditCall(text: string | undefined, preview: Preview | undefined, theme: any, cwd: string): string {
	const title = theme.fg("toolTitle", theme.bold("edit"));
	const paths = preview && !("error" in preview) ? preview.files : text ? extractHashHeaderPaths(text) : undefined;
	return `${title} ${renderUnifiedPathLabel(paths, theme, cwd)}`;
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
	const component = Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as Preview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
	state.callComponent = component;
	return component;
}

function headerBg(preview: Preview | undefined, settledError: boolean | undefined, theme: any): (text: string) => string {
	const key = preview ? ("error" in preview ? "toolErrorBg" : "toolSuccessBg") : settledError ? "toolErrorBg" : "toolPendingBg";
	return (text: string) => theme.bg(key, text);
}

function previewsDiffer(current: Preview | undefined, next: Preview): boolean {
	if (current === undefined) return true;
	if ("error" in current) return !("error" in next) || current.error !== next.error;
	return "error" in next || current.diff !== next.diff || current.firstChangedLine !== next.firstChangedLine || current.files.join("\0") !== next.files.join("\0");
}

function setUnifiedEditPreview(component: UnifiedEditCallRenderComponent, preview: Preview, argsKey: string | undefined): boolean {
	const changed = previewsDiffer(component.preview, preview);
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
	hashStore: HashSnapshotStore,
): void {
	if (!argsComplete || !text || !argsKey || component.preview !== undefined || component.previewPending) return;
	component.previewPending = true;
	const requestKey = argsKey;
	void buildHashChanges(text, cwd, hashStore)
		.then((changes): Preview => previewForChanges(changes))
		.catch((err): Preview => ({ error: errorText(err) }))
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
): UnifiedEditCallRenderComponent {
	component.setBgFn(headerBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatUnifiedEditCall(text, component.preview, theme, cwd), 0, 0));
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
		const text = result.content.map((item) => item.text || "").join("\n");
		return !text || text === previewError ? undefined : theme.fg("error", text);
	}
	const resultDiff = result.details?.diff;
	return resultDiff && resultDiff !== previewDiff ? renderDiff(resultDiff) : undefined;
}

export default function unifiedEditExtension(pi: ExtensionAPI) {
	const hashStore = new HashSnapshotStore();
	pi.on("tool_result", async (event, ctx) => formatHashReadResult(event, ctx.cwd, hashStore));
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: HASH_DESCRIPTION,
		promptSnippet: HASH_SNIPPET,
		promptGuidelines: HASH_GUIDELINES,
		parameters: unifiedEditSchema,
		renderShell: "self",
		prepareArguments: prepareUnifiedArguments,

		async execute(_toolCallId, params: UnifiedEditParams, signal, _onUpdate, ctx) {
			const text = params.text;
			if (typeof text !== "string" || text.trim() === "") throw new Error("edit requires a non-empty text payload.");
			let changes: HashFileChange[];
			try {
				changes = await buildHashChanges(text, ctx.cwd, hashStore);
			} catch (err) {
				throw new Error(
					`${errorText(err)}\nNo changes were applied — the payload is all-or-nothing: fix the failing part and resubmit the whole payload.`,
				);
			}
			const details = await applyChanges(changes, signal);
			let summary = formatSummary(details);
			const headers = recordAppliedHashChanges(hashStore, changes);
			if (headers.length > 0) summary += `\nFresh tags (re-read before another line-number edit):\n${headers.join("\n")}`;
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
			requestUnifiedEditPreview(component, text, key, context.cwd, context.argsComplete, () => context.invalidate(), hashStore);
			return buildUnifiedEditCallComponent(component, text, theme, context.cwd);
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
				if (changed) buildUnifiedEditCallComponent(component, text, theme, context.cwd);
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

export const __test = { applyChanges };
