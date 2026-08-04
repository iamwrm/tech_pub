/**
 * Shared prompt history across pi sessions and live pi instances.
 *
 * Usage:
 * - Put this file in `.pi/extensions/` and run `/reload`
 * - Press Up in an empty editor to browse shared prompt history
 * - Press Ctrl-R to fuzzy-search shared prompt history
 * - In search: first Enter previews the full prompt, second Enter inserts it into the editor
 * - Run `/history-search` as an alternative to Ctrl-R
 *
 * Note: Ctrl-R is also the default built-in "rename session" binding inside the
 * /resume session picker overlay. Functionally the two never competed for the same
 * focus (extension shortcuts only fire while focus is on the main editor, picker
 * bindings only fire inside the /resume overlay), but pi's shortcut-conflict
 * detector does not model picker scope and therefore prints an
 * `[Extension issues] Extension shortcut conflict: 'ctrl+r' is built-in shortcut
 * for app.session.rename ...` banner on every startup/reload. To silence it,
 * remap `app.session.rename` to a non-overlapping key in
 * ~/.pi/agent/keybindings.json, for example:
 *
 *     { "app.session.rename": ["ctrl+shift+r"] }
 *
 * Features:
 * - global shared history store in ~/.pi/prompt-history.jsonl
 * - near-real-time sync between multiple running pi instances
 * - up-arrow history survives /new, /resume, restart, and second live instances
 * - Ctrl-R opens a searchable history picker
 *
 * Notes:
 * - Uses an append-only JSONL log for concurrency-friendly cross-process writes.
 * - Uses a custom editor so we can seed and update the editor history buffer.
 * - Keeps default editor behavior; only history seeding/sync is added.
 */

import {
	CustomEditor,
	DynamicBorder,
	getSelectListTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	Container,
	Input,
	Key,
	SelectList,
	Text,
	fuzzyFilter,
	matchesKey,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

type HistoryEntry = {
	id: string;
	ts: number;
	cwd: string;
	kind: "prompt";
	text: string;
};

type SearchItem = {
	id: string;
	text: string;
	cwd: string;
	ts: number;
};

const HISTORY_FILE = resolve(homedir(), ".pi", "prompt-history.jsonl");
const POLL_INTERVAL_MS = 500;
const WATCH_DEBOUNCE_MS = 100;
const MAX_SEEN_IDS = 1000;

class SharedHistoryEditor extends CustomEditor {
	ingestHistory(text: string): void {
		super.addToHistory(text);
	}
}

function normalizeText(text: string): string {
	return text.trim();
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	return !!value && typeof value === "object" && (value as { type?: unknown }).type === "text";
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(isTextBlock).map((block) => block.text).join("");
}

function parseHistoryEntry(line: string): HistoryEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;

	try {
		const value = JSON.parse(trimmed) as Partial<HistoryEntry>;
		if (
			typeof value.id !== "string" ||
			typeof value.ts !== "number" ||
			typeof value.cwd !== "string" ||
			value.kind !== "prompt" ||
			typeof value.text !== "string"
		) {
			return undefined;
		}
		return value as HistoryEntry;
	} catch {
		return undefined;
	}
}

function rememberId(seenIds: Set<string>, seenOrder: string[], id: string): boolean {
	if (seenIds.has(id)) return false;
	seenIds.add(id);
	seenOrder.push(id);
	while (seenOrder.length > MAX_SEEN_IDS) {
		const oldest = seenOrder.shift();
		if (oldest) seenIds.delete(oldest);
	}
	return true;
}

function formatTimestamp(ts: number): string {
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

async function loadSearchItems(filePath: string, limit = 500): Promise<SearchItem[]> {
		try {
			const content = await readFile(filePath, "utf8");
			const lines = content.split("\n");
			const items: SearchItem[] = [];
			const seenTexts = new Set<string>();

			for (let i = lines.length - 1; i >= 0; i--) {
				const entry = parseHistoryEntry(lines[i] ?? "");
				if (!entry) continue;
				const normalized = normalizeText(entry.text);
				if (!normalized || seenTexts.has(normalized)) continue;
				seenTexts.add(normalized);
				items.push({
					id: entry.id,
					text: normalized,
					cwd: entry.cwd,
					ts: entry.ts,
				});
				if (items.length >= limit) break;
			}

			return items;
		} catch {
			return [];
		}
}

class HistorySearchOverlay extends Container implements Focusable {
	private tui: TUI;
	private theme: any;
	private queryInput: Input;
	private selectList: SelectList;
	private allItems: SearchItem[];
	private filteredItems: SearchItem[];
	private done: (value: string | null) => void;
	private listTheme = getSelectListTheme();
	private previewedId: string | undefined;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.queryInput.focused = value;
	}

	constructor(tui: TUI, theme: any, items: SearchItem[], done: (value: string | null) => void) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allItems = items;
		this.filteredItems = items;
		this.done = done;
		this.queryInput = new Input();
		this.selectList = this.createSelectList();
		this.rebuild();
	}

	handleInput(data: string): void {
		if (this.previewedId) {
			if (matchesKey(data, Key.enter)) {
				const previewed = this.getPreviewedItem();
				this.done(previewed?.text ?? null);
				return;
			}

			if (matchesKey(data, Key.escape)) {
				this.previewedId = undefined;
				this.rebuild();
				this.tui.requestRender();
				return;
			}

			return;
		}

		const before = this.queryInput.getValue();

		if (matchesKey(data, Key.ctrl("r")) || matchesKey(data, Key.up)) {
			this.previewedId = undefined;
			this.selectList.handleInput("\x1b[A");
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.previewedId = undefined;
			this.selectList.handleInput("\x1b[B");
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			const selected = this.getSelectedItem();
			if (!selected) return;
			this.previewedId = selected.id;
			this.rebuild();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}

		this.queryInput.handleInput(data);
		if (this.queryInput.getValue() !== before) {
			this.applyFilter();
		}
		this.tui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private applyFilter(): void {
		const query = normalizeText(this.queryInput.getValue());
		this.previewedId = undefined;
		this.filteredItems = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.text} ${item.cwd}`)
			: this.allItems;
		this.selectList = this.createSelectList();
		this.rebuild();
	}

	private createSelectList(): SelectList {
		const selectList = new SelectList(
			this.filteredItems.map((item) => ({
				value: item.id,
				label: item.text,
				description: `${item.cwd} • ${formatTimestamp(item.ts)}`,
			})),
			10,
			this.listTheme,
		);
		selectList.onSelect = (item) => {
			const match = this.filteredItems.find((candidate) => candidate.id === item.value);
			this.done(match?.text ?? null);
		};
		selectList.onCancel = () => this.done(null);
		return selectList;
	}

	private getSelectedItem(): SearchItem | undefined {
		const selected = this.selectList.getSelectedItem();
		if (!selected) return undefined;
		return this.filteredItems.find((item) => item.id === selected.value);
	}

	private getPreviewedItem(): SearchItem | undefined {
		if (!this.previewedId) return undefined;
		return this.allItems.find((item) => item.id === this.previewedId);
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(" History search ")), 1, 0));

		const previewed = this.getPreviewedItem();
		if (previewed) {
			this.addChild(new Text(this.theme.fg("muted", `${previewed.cwd} • ${formatTimestamp(previewed.ts)}`), 1, 0));
			this.addChild(new Text(this.theme.fg("dim", "Preview"), 1, 0));
			this.addChild(new Text(previewed.text, 1, 0));
			this.addChild(new Text(this.theme.fg("dim", "enter insert into editor • esc back to results"), 1, 0));
			this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
			return;
		}

		this.addChild(new Text(this.theme.fg("muted", "Type to fuzzy-search prompt history"), 1, 0));
		this.addChild(new Text(this.theme.fg("dim", "Query"), 1, 0));
		this.addChild(this.queryInput);
		this.addChild(this.selectList);
		const help = this.filteredItems.length > 0 ? "↑↓ navigate • enter preview • esc cancel" : "Type to search • esc cancel";
		this.addChild(new Text(this.theme.fg("dim", help), 1, 0));
		this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
	}
}

async function openHistorySearch(ctx: ExtensionContext, filePath: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Shared prompt history search is available only in interactive TUI mode", "info");
		return;
	}

	const items = await loadSearchItems(filePath);
	if (items.length === 0) {
		ctx.ui.notify("No shared prompt history yet", "info");
		return;
	}

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => new HistorySearchOverlay(tui, theme, items, done),
		{
			overlay: true,
			overlayOptions: {
				width: "70%",
				maxHeight: "70%",
				minWidth: 50,
				anchor: "center",
			},
		},
	);

	if (result) {
		const current = ctx.ui.getEditorText();
		if (current) {
			const sep = current.endsWith("\n") || current.endsWith(" ") ? "" : "\n";
			ctx.ui.setEditorText(current + sep + result);
		} else {
			ctx.ui.setEditorText(result);
		}
	}
}

export default function sharedPromptHistory(pi: ExtensionAPI) {
	const instanceId = randomUUID();
	let sequence = 0;

	let editor: SharedHistoryEditor | undefined;
	let pendingHistory: string[] = [];
	let stopSync: (() => void) | undefined;
	let currentSessionTexts = new Set<string>();
	let historyFilePath: string | undefined;
	let seenIds = new Set<string>();
	let seenIdOrder: string[] = [];

	pi.registerShortcut("ctrl+r", {
		description: "Search shared prompt history",
		handler: async (ctx) => {
			await openHistorySearch(ctx, historyFilePath ?? HISTORY_FILE);
		},
	});

	pi.registerCommand("history-search", {
		description: "Search shared prompt history",
		handler: async (_args, ctx) => {
			await openHistorySearch(ctx, historyFilePath ?? HISTORY_FILE);
		},
	});

	function resetRuntimeState(): void {
		stopSync?.();
		stopSync = undefined;
		editor = undefined;
		pendingHistory = [];
		currentSessionTexts = new Set<string>();
		historyFilePath = undefined;
		seenIds = new Set<string>();
		seenIdOrder = [];
	}

	function ingestIntoEditor(text: string): void {
		const normalized = normalizeText(text);
		if (!normalized) return;
		if (editor) {
			editor.ingestHistory(normalized);
		} else {
			pendingHistory.push(normalized);
		}
	}

	function flushPendingHistory(): void {
		if (!editor || pendingHistory.length === 0) return;
		for (const text of pendingHistory) {
			editor.ingestHistory(text);
		}
		pendingHistory = [];
	}

	async function ensureHistoryFile(filePath: string): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, "", { flag: "a" });
	}

	async function appendPromptHistory(filePath: string, cwd: string, text: string): Promise<void> {
		const normalized = normalizeText(text);
		if (!normalized) return;

		const entry: HistoryEntry = {
			id: `${instanceId}:${++sequence}`,
			ts: Date.now(),
			cwd,
			kind: "prompt",
			text: normalized,
		};
		await ensureHistoryFile(filePath);
		await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	function buildCurrentSessionTextSet(ctx: { sessionManager: { getBranch(): readonly unknown[] } }): Set<string> {
		const texts = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!entry || typeof entry !== "object") continue;
			const typedEntry = entry as {
				type?: unknown;
				message?: { role?: unknown; content?: unknown };
			};
			if (typedEntry.type !== "message") continue;
			if (typedEntry.message?.role !== "user") continue;
			const text = normalizeText(extractUserText(typedEntry.message.content));
			if (text) texts.add(text);
		}
		return texts;
	}

	async function startHistorySync(filePath: string): Promise<() => void> {
		await ensureHistoryFile(filePath);

		let watcher: FSWatcher | undefined;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		let syncInFlight = false;
		let rerunRequested = false;
		let offset = 0;
		let remainder = "";

		const processChunk = (chunk: string, mode: "replay" | "live") => {
			const combined = remainder + chunk;
			const lines = combined.split("\n");
			remainder = lines.pop() ?? "";

			for (const line of lines) {
				const entry = parseHistoryEntry(line);
				if (!entry) continue;
				if (!rememberId(seenIds, seenIdOrder, entry.id)) continue;
				if (entry.id.startsWith(`${instanceId}:`)) continue;

				const normalized = normalizeText(entry.text);
				if (!normalized) continue;

				if (mode === "replay" && currentSessionTexts.has(normalized)) {
					continue;
				}

				ingestIntoEditor(normalized);
			}
		};

		const syncOnce = async (mode: "replay" | "live") => {
			if (disposed) return;
			if (syncInFlight) {
				rerunRequested = true;
				return;
			}
			syncInFlight = true;

			try {
				const handle = await open(filePath, "r");
				try {
					const stats = await handle.stat();
					if (stats.size < offset) {
						offset = 0;
						remainder = "";
					}

					const unreadBytes = stats.size - offset;
					if (unreadBytes <= 0) return;

					const buffer = Buffer.alloc(unreadBytes);
					await handle.read(buffer, 0, unreadBytes, offset);
					offset = stats.size;
					processChunk(buffer.toString("utf8"), mode);
				} finally {
					await handle.close();
				}
			} catch {
				// Best-effort sync. Keep polling/watch active and try again later.
			} finally {
				syncInFlight = false;
				if (rerunRequested && !disposed) {
					rerunRequested = false;
					void syncOnce("live");
				}
			}
		};

		const scheduleLiveSync = () => {
			if (disposed) return;
			if (debounceTimer) return;
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				void syncOnce("live");
			}, WATCH_DEBOUNCE_MS);
		};

		await syncOnce("replay");
		flushPendingHistory();

		try {
			watcher = watch(filePath, () => {
				scheduleLiveSync();
			});
		} catch {
			// Polling below is the reliability fallback.
		}
		pollTimer = setInterval(() => {
			void syncOnce("live");
		}, POLL_INTERVAL_MS);

		return () => {
			disposed = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			if (pollTimer) clearInterval(pollTimer);
			watcher?.close();
		};
	}

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" as const };
		const normalized = normalizeText(event.text);
		if (!normalized) return { action: "continue" as const };

		const filePath = historyFilePath ?? HISTORY_FILE;
		historyFilePath = filePath;
		currentSessionTexts.add(normalized);

		try {
			await appendPromptHistory(filePath, ctx.cwd, normalized);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`shared-prompt-history: ${message}`, "warning");
		}

		return { action: "continue" as const };
	});

	pi.on("session_start", async (_event, ctx) => {
		resetRuntimeState();
		// Custom editors and filesystem synchronization serve only the TUI.
		// RPC reports hasUI=true, but setEditorComponent() is a no-op there.
		if (ctx.mode !== "tui") return;
		historyFilePath = HISTORY_FILE;
		currentSessionTexts = buildCurrentSessionTextSet(ctx);

		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const sharedEditor = new SharedHistoryEditor(tui, theme, kb);
			editor = sharedEditor;
			flushPendingHistory();
			return sharedEditor;
		});

		try {
			stopSync = await startHistorySync(historyFilePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`shared-prompt-history failed to start: ${message}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		resetRuntimeState();
	});
}
