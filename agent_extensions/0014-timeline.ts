/**
 * Standalone mirror of iamwrm/piagent-config
 * `packages/ren-public-package/0014-timeline.ts` (the source of truth, where it
 * ships with tests). This vertical-only fullscreen timeline is self-contained
 * and can be copied alone into agent_extensions.
 * Try it without installing: `pi -e ./0014-timeline.ts`
 *
 * Inlined: scrubTerminalSequences from terminal-sanitizer.ts plus the
 * fullscreen rail.
 *
 * Conversation timeline: a default-on, vertical-only Grok-style navigator
 * over Pi's fullscreen transcript. /timeline remains the explicit hide/show
 * toggle.
 *
 * The fullscreen private seams were most recently validated on Pi 1.3.0.
 * Compatible runtimes get a one-column "spine" that replaces the native
 * scrollbar: every prompt is a tick at its proportional transcript position
 * (long turns leave long gaps), the viewport is the scrollbar thumb, and the
 * prompt owning the viewport is an accent ◆. Hover (or keyboard focus) shows a
 * card with turn number, age, tool count and the prompt preview; click jumps.
 * The scrollback's last row is the follow control: ● while following live
 * (accent while the agent runs), otherwise ↓ or ↓ N with N newer prompts below;
 * clicking it jumps to the transcript end and restores Pi's live follow mode.
 *
 * Pi does not expose those seams publicly, so this file applies a fail-closed
 * in-memory prototype patch only when the expected runtime method/property
 * shapes are present and restores it on shutdown. It never patches Pi files
 * on disk. There is intentionally no horizontal or regular-mode fallback:
 * incompatible runtimes, regular/RPC modes, narrow terminals, and transcripts
 * without jumpable prompt anchors keep Pi's normal UI.
 *
 * alt+, / alt+. step the vertical selection and show the same preview as
 * hover. Navigating away pauses transcript following; ↓ scrolls to the newest
 * model/tool output and returns to ●, which stays pinned as output grows. Pi intentionally does not emit passive motion under
 * tmux/Zellij/screen, so those environments get click plus keyboard navigation
 * without forcing a laggy terminal mode.
 *
 * Enabled by default in fullscreen TUI sessions; /timeline hides or re-shows
 * it. Turns are recomputed from the active branch
 * (ctx.sessionManager.getBranch()) on every lifecycle boundary, so the rail
 * stays correct across /tree branch switches, session restores, and forks
 * without persisted state. The rail projects that branch onto Pi's rendered
 * prompt anchors, so compacted-away or textless turns cannot create visible
 * ticks whose clicks would be no-ops.
 */

import {
	AssistantMessageComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	TuiAltScreen,
	compositeTuiLine,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

const ESC = "\x1b";

/** True for CSI parameter bytes (0x30–0x3F: digits ; : < = > ?). */
function isCsiParam(code: number): boolean {
	return code >= 0x30 && code <= 0x3f;
}

/** True for CSI intermediate bytes (0x20–0x2F). */
function isCsiIntermediate(code: number): boolean {
	return code >= 0x20 && code <= 0x2f;
}

/** True for CSI final bytes (0x40–0x7E). */
function isCsiFinal(code: number): boolean {
	return code >= 0x40 && code <= 0x7e;
}

/** Plain SGR params: digits, `;`, `:` only — no private markers like `?`/`>`/`<`/`=`. */
function isPlainSgrParams(params: string): boolean {
	return /^[0-9;:]*$/.test(params);
}

/**
 * Consume a CSI sequence starting after the introducer. Returns the index
 * after the sequence and the sequence's parameter/final split, or end-of-input
 * for an unterminated sequence.
 */
function consumeCsi(input: string, start: number): { end: number; params: string; intermediates: string; final: string } {
	let i = start;
	let params = "";
	let intermediates = "";
	while (i < input.length && isCsiParam(input.charCodeAt(i))) {
		params += input[i];
		i++;
	}
	while (i < input.length && isCsiIntermediate(input.charCodeAt(i))) {
		intermediates += input[i];
		i++;
	}
	if (i < input.length && isCsiFinal(input.charCodeAt(i))) {
		return { end: i + 1, params, intermediates, final: input[i] };
	}
	// Unterminated/malformed: swallow what we saw so no partial sequence leaks.
	return { end: i, params, intermediates, final: "" };
}

/** Consume a terminal string through ST; OSC also permits BEL. */
function consumeUntilStringTerminator(input: string, start: number, allowBel: boolean): number {
	let i = start;
	while (i < input.length) {
		const ch = input[i];
		if (allowBel && ch === "\x07") return i + 1;
		if (ch === ESC && input[i + 1] === "\\") return i + 2;
		if (ch === "\x9c") return i + 1;
		i++;
	}
	return i; // unterminated: swallow to end
}

/**
 * Remove terminal-state-changing sequences from text, keeping plain SGR
 * styling and \n / \r / \t.
 */
export function scrubTerminalSequences(input: string): string {
	let out = "";
	let i = 0;
	const len = input.length;

	while (i < len) {
		const ch = input[i];
		const code = input.charCodeAt(i);

		if (
			ch === ESC ||
			code === 0x90 ||
			code === 0x98 ||
			code === 0x9b ||
			code === 0x9d ||
			code === 0x9e ||
			code === 0x9f
		) {
			const isRawCsi = code === 0x9b;
			const isRawOsc = code === 0x9d;
			const isRawString = code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f;
			const next = isRawCsi || isRawOsc || isRawString ? "" : input[i + 1];

			if (isRawCsi || next === "[") {
				const seq = consumeCsi(input, isRawCsi ? i + 1 : i + 2);
				if (seq.final === "m" && seq.intermediates === "" && isPlainSgrParams(seq.params)) {
					out += `${ESC}[${seq.params}m`; // normalize to 7-bit SGR
				}
				i = seq.end;
				continue;
			}
			if (isRawOsc || next === "]") {
				i = consumeUntilStringTerminator(input, isRawOsc ? i + 1 : i + 2, true);
				continue;
			}
			if (isRawString) {
				i = consumeUntilStringTerminator(input, i + 1, false);
				continue;
			}
			if (next === "P" || next === "X" || next === "^" || next === "_") {
				i = consumeUntilStringTerminator(input, i + 2, false);
				continue;
			}
			// Remaining ESC forms: optional intermediates (0x20–0x2F) + one final.
			let j = i + 1;
			while (j < len && isCsiIntermediate(input.charCodeAt(j))) j++;
			i = j < len ? j + 1 : len;
			continue;
		}

		if ((code < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t") || (code >= 0x80 && code <= 0x9f)) {
			i++; // remaining C0/C1 controls (BEL, BS, SO/SI, ST, IND, NEL, …)
			continue;
		}

		out += ch;
		i++;
	}

	return out;
}

export const TIMELINE_MIN_TERMINAL_WIDTH = 30;
export const TIMELINE_MIN_SCROLLBACK_WIDTH = 13;
export const TIMELINE_RAIL_WIDTH = 1;
export const TIMELINE_LATEST_LABEL = "↓";
export const TIMELINE_FOLLOWING_LABEL = "●";
export const TIMELINE_OLDER_LABEL = "↑";
/** Track rows per prompt before the rail pages; keeps gaps and the thumb legible. */
export const TIMELINE_ROWS_PER_TICK = 2;
export const TIMELINE_PREVIEW_MAX_CHARS = 120;
export const TIMELINE_PREVIEW_MIN_TEXT_WIDTH = 16;
export const TIMELINE_PREVIEW_MAX_TEXT_WIDTH = 32;

const TRACK_GLYPH = "│";
const THUMB_GLYPH = "┃";
const TICK_GLYPH = "•";
const ACTIVE_TICK_GLYPH = "◆";
const HOVER_TICK_GLYPH = "◇";

const PATCH_KEY = Symbol.for("ren-public-package.timeline-fullscreen.patch.v1");
const PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

export interface FullscreenTimelineTurn {
	id: string;
	/** Exact text Pi's UserMessageComponent receives (text blocks concatenated). */
	renderText: string;
	preview: string;
	/** 1-based position among the branch's user prompts, compacted ones included. */
	ordinal: number;
	/** Prompt time in epoch milliseconds, when the session recorded one. */
	timestamp?: number;
	/** Tool calls the assistant made before the next prompt. */
	toolCount: number;
}

export interface TimelineRuntimeTheme {
	dim(text: string): string;
	accent(text: string): string;
	text(text: string): string;
	panel(text: string): string;
	track(text: string): string;
	thumb(text: string): string;
}

export const PLAIN_RUNTIME_THEME: TimelineRuntimeTheme = {
	dim: (text) => text,
	accent: (text) => text,
	text: (text) => text,
	panel: (text) => text,
	track: (text) => text,
	thumb: (text) => text,
};

interface TimelineHost {
	getTurns(): readonly FullscreenTimelineTurn[];
	getSelected(): number;
	select(turnIndex: number): void;
	/** True while the agent is producing output; tints the live-follow dot. */
	isBusy?(): boolean;
}

export interface TimelineRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type VerticalTimelineHit = { type: "tick"; turnIndex: number } | { type: "latest" } | { type: "older" };

/**
 * One-column spine over the scrollbar gutter. Every rail turn of the shown
 * page sits at its proportional position within that page's transcript span;
 * the thumb marks the visible rows. The scrollback's last row holds the follow
 * control. Beyond one prompt per TIMELINE_ROWS_PER_TICK rows the rail pages
 * from the newest end, and the first row becomes the ↑ K older-prompts control.
 */
export interface VerticalTimelineRail {
	/** The track column, excluding control rows. */
	rect: TimelineRect;
	/** Rail indices [start, end) shown on this page. */
	page: { start: number; end: number; index: number; count: number; size: number };
	/** Absolute screen row of each shown tick; tickRows[i] belongs to rail index page.start + i. */
	tickRows: number[];
	/** Absolute screen rows [top, top + height) covered by the viewport thumb; height 0 when off-page. */
	thumb: { top: number; height: number };
	latestRect: TimelineRect;
	latestLabel: string;
	/** Present only when paging and an older page exists. */
	olderRect?: TimelineRect;
	olderLabel?: string;
	active?: number;
	followingEnd: boolean;
	/** Rail prompts that start below the visible viewport. */
	newerBelow: number;
}

export interface TimelineViewport {
	active?: number;
	followingEnd: boolean;
	scrollTop: number;
	contentHeight: number;
}

interface RuntimeScrollView {
	children?: Component[];
	readonly scrollTop: number;
	readonly scrollbar: string;
	readonly isFollowingEnd: boolean;
	scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void;
	scrollToEnd(): void;
	setScrollbar(scrollbar: "hidden" | "auto" | "always"): void;
}

interface RuntimeLayoutBox {
	rect: TimelineRect;
	children: RuntimeLayoutBox[];
	scrollView?: RuntimeScrollView;
	scrollContentLines?: readonly string[];
}

interface RuntimeLayoutFrame {
	root: RuntimeLayoutBox;
	primaryScrollView?: RuntimeScrollView;
	width: number;
	height: number;
}

interface RuntimeOverlayOptions {
	width?: number | string;
	minWidth?: number;
	maxHeight?: number | string;
	anchor?: string;
	offsetX?: number;
	offsetY?: number;
	row?: number | string;
	col?: number | string;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	visible?: (termWidth: number, termHeight: number) => boolean;
	nonCapturing?: boolean;
}

interface RuntimeOverlayEntry {
	component: Component;
	options?: RuntimeOverlayOptions;
	hidden: boolean;
}

interface RuntimeTui extends TUI {
	currentLayout?: RuntimeLayoutFrame;
	overlayStack?: RuntimeOverlayEntry[];
	resolveOverlayLayout?: (
		options: RuntimeOverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	) => { width: number; row: number; col: number; maxHeight?: number };
}

interface ViewportSnapshot {
	box: RuntimeLayoutBox;
	scrollView: RuntimeScrollView;
	anchors: Map<number, number>;
	viewport: TimelineViewport;
	signature: string;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface RuntimePrototype {
	handleViewportInput?: (this: RuntimeTui, data: string) => { consume?: boolean } | undefined;
	compositeOverlays?: (this: RuntimeTui, lines: string[], width: number, height: number) => string[];
	doRender?: (this: RuntimeTui) => void;
}

interface RuntimePatchController {
	wantsRuntime(): boolean;
	bindRuntimeTui(tui: RuntimeTui): void;
	handleViewportInput(tui: RuntimeTui, data: string): boolean;
	composite(tui: RuntimeTui, lines: string[], width: number, height: number): string[];
	afterRender(tui: RuntimeTui): void;
	runtimeCrashed(): void;
}

interface RuntimePatchState {
	patched: boolean;
	controllers: Set<RuntimePatchController>;
	prototype?: RuntimePrototype;
	originalHandleViewportInput?: NonNullable<RuntimePrototype["handleViewportInput"]>;
	originalCompositeOverlays?: NonNullable<RuntimePrototype["compositeOverlays"]>;
	originalDoRender?: NonNullable<RuntimePrototype["doRender"]>;
	hadOwnCompositeOverlays?: boolean;
}

function globalPatchState(): RuntimePatchState {
	const target = globalThis as unknown as Record<symbol, RuntimePatchState | undefined>;
	return (target[PATCH_KEY] ??= { patched: false, controllers: new Set() });
}

function activeController(state: RuntimePatchState): RuntimePatchController | undefined {
	const controllers = [...state.controllers];
	for (let index = controllers.length - 1; index >= 0; index--) {
		const controller = controllers[index];
		if (controller?.wantsRuntime()) return controller;
	}
	return undefined;
}

function safelyCrash(controller: RuntimePatchController | undefined): void {
	try {
		controller?.runtimeCrashed();
	} catch {
		// The original Pi input/render path must remain available even when cleanup fails.
	}
}

function installRuntimePatch(controller: RuntimePatchController): boolean {
	if (process.env.PI_TIMELINE_FULLSCREEN_PATCH === "0") return false;

	const state = globalPatchState();
	state.controllers.add(controller);
	if (state.patched) return true;

	const prototype = TuiAltScreen.prototype as unknown as RuntimePrototype;
	const originalHandleViewportInput = prototype.handleViewportInput;
	const originalCompositeOverlays = prototype.compositeOverlays;
	const originalDoRender = prototype.doRender;
	if (
		typeof originalHandleViewportInput !== "function" ||
		typeof originalCompositeOverlays !== "function" ||
		typeof originalDoRender !== "function"
	) {
		state.controllers.delete(controller);
		return false;
	}

	state.prototype = prototype;
	state.originalHandleViewportInput = originalHandleViewportInput;
	state.originalCompositeOverlays = originalCompositeOverlays;
	state.originalDoRender = originalDoRender;
	state.hadOwnCompositeOverlays = Object.prototype.hasOwnProperty.call(prototype, "compositeOverlays");

	prototype.handleViewportInput = function patchedTimelineViewportInput(data: string) {
		const current = activeController(state);
		if (current) {
			try {
				current.bindRuntimeTui(this);
				if (current.handleViewportInput(this, data)) return { consume: true };
			} catch {
				safelyCrash(current);
			}
		}
		return originalHandleViewportInput.call(this, data);
	};

	prototype.compositeOverlays = function patchedTimelineComposite(lines: string[], width: number, height: number) {
		const current = activeController(state);
		let base = lines;
		if (current) {
			try {
				current.bindRuntimeTui(this);
				base = current.composite(this, lines, width, height);
			} catch {
				safelyCrash(current);
			}
		}
		// Pi's overlays render after the timeline, naturally occluding the rail
		// and popup instead of letting this private patch paint over dialogs/HUDs.
		return originalCompositeOverlays.call(this, base, width, height);
	};

	prototype.doRender = function patchedTimelineDoRender() {
		originalDoRender.call(this);
		const current = activeController(state);
		if (!current) return;
		try {
			current.bindRuntimeTui(this);
			current.afterRender(this);
		} catch {
			safelyCrash(current);
		}
	};

	state.patched = true;
	return true;
}

function uninstallRuntimePatch(controller: RuntimePatchController): void {
	const state = globalPatchState();
	state.controllers.delete(controller);
	if (!state.patched || state.controllers.size > 0 || !state.prototype) return;

	if (state.originalHandleViewportInput) state.prototype.handleViewportInput = state.originalHandleViewportInput;
	if (state.originalDoRender) state.prototype.doRender = state.originalDoRender;
	if (state.hadOwnCompositeOverlays) {
		if (state.originalCompositeOverlays) state.prototype.compositeOverlays = state.originalCompositeOverlays;
	} else {
		delete state.prototype.compositeOverlays;
	}
	state.patched = false;
	state.prototype = undefined;
	state.originalHandleViewportInput = undefined;
	state.originalCompositeOverlays = undefined;
	state.originalDoRender = undefined;
	state.hadOwnCompositeOverlays = undefined;
}

/** First non-empty prompt line, capped exactly like Grok's timeline snapshot. */
export function timelinePromptPreview(text: string, maxChars = TIMELINE_PREVIEW_MAX_CHARS): string {
	const line = text
		.split("\n")
		.map((value) => value.trim())
		.find((value) => value.length > 0) ?? "";
	const limit = Math.max(1, Math.floor(maxChars));
	const chars = [...line];
	if (chars.length <= limit) return line;
	return `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * Map content rows onto track rows. While every tick can own a row, collisions
 * are nudged apart (keeping order) so each prompt stays individually clickable.
 */
export function spreadTimelineTicks(idealRows: readonly number[], trackRows: number): number[] {
	const last = Math.max(0, trackRows - 1);
	const rows = idealRows.map((row) => Math.min(Math.max(0, Math.floor(row)), last));
	if (rows.length > trackRows) return rows;
	for (let index = 1; index < rows.length; index++) rows[index] = Math.max(rows[index]!, rows[index - 1]! + 1);
	for (let index = rows.length - 1; index >= 0; index--) {
		rows[index] = Math.min(rows[index]!, index === rows.length - 1 ? last : rows[index + 1]! - 1);
	}
	return rows;
}

/** Rail indices of a page; pages are aligned to the newest end so the last page is always full. */
export function timelinePageBounds(turnCount: number, pageSize: number, page: number): { start: number; end: number } {
	const size = Math.max(1, Math.floor(pageSize));
	const count = Math.max(1, Math.ceil(turnCount / size));
	const index = Math.min(Math.max(0, Math.floor(page)), count - 1);
	const end = turnCount - (count - 1 - index) * size;
	return { start: Math.max(0, end - size), end };
}

/** Page holding a rail index under newest-end alignment; undefined means the newest page. */
export function timelinePageOf(turnCount: number, pageSize: number, railIndex: number | undefined): number {
	const size = Math.max(1, Math.floor(pageSize));
	const last = Math.max(0, Math.ceil(turnCount / size) - 1);
	if (railIndex === undefined) return last;
	return Math.max(0, last - Math.floor((turnCount - 1 - railIndex) / size));
}

export function computeVerticalTimelineRail(
	scrollback: TimelineRect,
	anchorRows: readonly number[],
	viewport: TimelineViewport,
	requestedPage?: number,
): VerticalTimelineRail | undefined {
	if (anchorRows.length < 1 || scrollback.width < TIMELINE_MIN_SCROLLBACK_WIDTH || scrollback.height < 4) return undefined;
	const turnCount = anchorRows.length;
	const contentHeight = Math.max(1, viewport.contentHeight, ...anchorRows.map((row) => row + 1));
	const paged = turnCount > Math.floor((scrollback.height - 1) / TIMELINE_ROWS_PER_TICK);
	const trackTop = scrollback.y + (paged ? 1 : 0);
	const trackRows = scrollback.height - 1 - (paged ? 1 : 0);
	const pageSize = paged ? Math.max(1, Math.floor(trackRows / TIMELINE_ROWS_PER_TICK)) : turnCount;
	const pageCount = Math.ceil(turnCount / pageSize);
	const pageIndex = Math.min(
		Math.max(0, requestedPage ?? timelinePageOf(turnCount, pageSize, viewport.active)),
		pageCount - 1,
	);
	const { start, end } = timelinePageBounds(turnCount, pageSize, pageIndex);

	// A page spans from its first prompt (the transcript top for page 0) to the
	// next page's first prompt (the transcript end for the newest page).
	const spanStart = start === 0 ? 0 : anchorRows[start]!;
	const spanEnd = end === turnCount ? contentHeight : anchorRows[end]!;
	const scale = trackRows / Math.max(1, spanEnd - spanStart);
	const tickRows = spreadTimelineTicks(
		anchorRows.slice(start, end).map((row) => (row - spanStart) * scale),
		trackRows,
	).map((row) => trackTop + row);

	const scrollTop = Math.min(Math.max(0, viewport.scrollTop), contentHeight);
	const viewportEnd = Math.min(contentHeight, scrollTop + scrollback.height);
	const visibleStart = Math.max(scrollTop, spanStart);
	const visibleEnd = Math.min(viewportEnd, spanEnd);
	let thumb = { top: trackTop, height: 0 };
	if (visibleEnd > visibleStart || (visibleEnd === visibleStart && spanStart === spanEnd)) {
		const thumbStart = Math.min(trackRows - 1, Math.floor((visibleStart - spanStart) * scale));
		const thumbEnd = Math.min(trackRows, Math.max(thumbStart + 1, Math.ceil((visibleEnd - spanStart) * scale)));
		thumb = { top: trackTop + thumbStart, height: thumbEnd - thumbStart };
	}

	const followingEnd = viewport.followingEnd === true;
	const newerBelow = anchorRows.filter((row) => row >= viewportEnd).length;
	const latestLabel = followingEnd
		? TIMELINE_FOLLOWING_LABEL
		: newerBelow > 0
			? `${TIMELINE_LATEST_LABEL} ${newerBelow}`
			: TIMELINE_LATEST_LABEL;
	const railX = scrollback.x + scrollback.width - TIMELINE_RAIL_WIDTH;
	const controlRect = (label: string, y: number): TimelineRect => {
		const width = visibleWidth(label);
		return { x: railX + TIMELINE_RAIL_WIDTH - width, y, width, height: 1 };
	};
	const olderLabel = start > 0 ? `${TIMELINE_OLDER_LABEL} ${start}` : undefined;
	return {
		rect: { x: railX, y: trackTop, width: TIMELINE_RAIL_WIDTH, height: trackRows },
		page: { start, end, index: pageIndex, count: pageCount, size: pageSize },
		tickRows,
		thumb,
		latestRect: controlRect(latestLabel, scrollback.y + scrollback.height - 1),
		latestLabel,
		...(olderLabel === undefined ? {} : { olderLabel, olderRect: controlRect(olderLabel, scrollback.y) }),
		...(viewport.active === undefined ? {} : { active: viewport.active }),
		followingEnd,
		newerBelow,
	};
}

/** Rail-wide bounds, including the control rows, for pointer ownership. */
export function timelineRailContains(rail: VerticalTimelineRail, x: number, y: number): boolean {
	return (
		pointInRect(rail.rect, x, y) ||
		pointInRect(rail.latestRect, x, y) ||
		(rail.olderRect !== undefined && pointInRect(rail.olderRect, x, y)) ||
		// The reserved older-control row stays rail-owned on the first page too.
		(rail.page.count > 1 && x === rail.rect.x && y === rail.rect.y - 1)
	);
}

export function hitVerticalTimelineRail(rail: VerticalTimelineRail, x: number, y: number): VerticalTimelineHit | undefined {
	if (pointInRect(rail.latestRect, x, y)) return { type: "latest" };
	if (rail.olderRect && pointInRect(rail.olderRect, x, y)) return { type: "older" };
	if (!pointInRect(rail.rect, x, y)) return undefined;
	const activeOffset = rail.active === undefined ? -1 : rail.active - rail.page.start;
	if (activeOffset >= 0 && rail.tickRows[activeOffset] === y) return { type: "tick", turnIndex: rail.active! };
	const offset = rail.tickRows.indexOf(y);
	return offset < 0 ? undefined : { type: "tick", turnIndex: rail.page.start + offset };
}

function sameHit(left: VerticalTimelineHit | undefined, right: VerticalTimelineHit | undefined): boolean {
	if (!left || !right) return left === right;
	return left.type === right.type && (left.type !== "tick" || right.type !== "tick" || left.turnIndex === right.turnIndex);
}

function pointInRect(rect: TimelineRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function parseTimelineMouse(data: string): SgrMouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	return {
		button: Number.parseInt(match[1]!, 10),
		x: Number.parseInt(match[2]!, 10) - 1,
		y: Number.parseInt(match[3]!, 10) - 1,
		release: match[4] === "m",
	};
}

export function wrapTimelinePreview(preview: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const wrapped = wrapTextWithAnsi(preview.trim(), safeWidth);
	if (wrapped.length <= 2) return wrapped;
	// Preview text is sanitized and unstyled. pi-tui's ANSI-aware truncator adds
	// full SGR resets around its ellipsis, which would clear the card background.
	const finalLine = stripTerminalSequences(truncateToWidth(wrapped.slice(1).join(" "), safeWidth, "…"));
	return [wrapped[0]!, finalLine];
}

/** Half-width hover card, bounded by its cap and the rail-side gap. */
export function timelinePreviewTextWidth(scrollbackWidth: number): number {
	const width = Math.max(1, Math.floor(scrollbackWidth));
	const available = Math.max(1, width - 6); // rail, one gap column, four frame columns
	const responsive = Math.max(TIMELINE_PREVIEW_MIN_TEXT_WIDTH, Math.floor(width / 2));
	return Math.max(1, Math.min(TIMELINE_PREVIEW_MAX_TEXT_WIDTH, responsive, available));
}

export function timelineRelativeAge(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 45) return "just now";
	const minutes = Math.max(1, Math.round(seconds / 60));
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** `#4 · 14m ago · 3 tools`; unknown or zero parts are omitted. */
export function timelineCardHeader(turn: FullscreenTimelineTurn, now: number): string {
	const parts = [`#${turn.ordinal}`];
	if (turn.timestamp !== undefined && Number.isFinite(turn.timestamp)) parts.push(timelineRelativeAge(turn.timestamp, now));
	if (turn.toolCount > 0) parts.push(`${turn.toolCount} ${turn.toolCount === 1 ? "tool" : "tools"}`);
	return parts.join(" · ");
}

function compositeCell(screen: string[], row: number, text: string, x: number, cellWidth: number, totalWidth: number): void {
	if (row < 0 || row >= screen.length || x < 0 || x >= totalWidth) return;
	screen[row] = compositeTuiLine(screen[row] ?? "", text, x, Math.min(cellWidth, totalWidth - x), totalWidth);
}

/** Pure final-screen compositor used by the runtime patch and focused tests. */
export function compositeVerticalTimeline(
	input: readonly string[],
	width: number,
	scrollback: TimelineRect,
	rail: VerticalTimelineRail,
	turns: readonly FullscreenTimelineTurn[],
	hovered: VerticalTimelineHit | undefined,
	theme: TimelineRuntimeTheme = PLAIN_RUNTIME_THEME,
	options: { now?: number; busy?: boolean } = {},
): string[] {
	const screen = [...input];
	while (screen.length < scrollback.y + scrollback.height) screen.push("");

	const tickRow = (turnIndex: number | undefined): number | undefined =>
		turnIndex === undefined || turnIndex < rail.page.start || turnIndex >= rail.page.end
			? undefined
			: rail.tickRows[turnIndex - rail.page.start];
	const ticksByRow = new Map<number, number>();
	for (let index = rail.tickRows.length - 1; index >= 0; index--) ticksByRow.set(rail.tickRows[index]!, rail.page.start + index);
	const activeRow = tickRow(rail.active);
	if (activeRow !== undefined) ticksByRow.set(activeRow, rail.active!);
	const hoveredTick = hovered?.type === "tick" ? hovered.turnIndex : undefined;
	const hoveredRow = tickRow(hoveredTick);
	if (hoveredTick !== undefined && hoveredRow !== undefined) {
		const row = hoveredRow;
		// The active diamond wins a shared row; otherwise show the hovered prompt.
		if (ticksByRow.get(row) !== rail.active) ticksByRow.set(row, hoveredTick);
	}

	const thumbEnd = rail.thumb.top + rail.thumb.height;
	for (let row = rail.rect.y; row < rail.rect.y + rail.rect.height; row++) {
		const inThumb = row >= rail.thumb.top && row < thumbEnd;
		const turnIndex = ticksByRow.get(row);
		let cell: string;
		if (turnIndex === undefined) cell = inThumb ? theme.thumb(THUMB_GLYPH) : theme.track(TRACK_GLYPH);
		else if (turnIndex === rail.active) cell = theme.accent(ACTIVE_TICK_GLYPH);
		else if (turnIndex === hoveredTick) cell = theme.accent(HOVER_TICK_GLYPH);
		else cell = theme.thumb(TICK_GLYPH);
		compositeCell(screen, row, cell, rail.rect.x, TIMELINE_RAIL_WIDTH, width);
	}

	const latestText = rail.followingEnd
		? options.busy
			? theme.accent(rail.latestLabel)
			: theme.dim(rail.latestLabel)
		: theme.panel(hovered?.type === "latest" ? theme.accent(rail.latestLabel) : theme.text(rail.latestLabel));
	compositeCell(screen, rail.latestRect.y, latestText, rail.latestRect.x, rail.latestRect.width, width);
	if (rail.olderRect && rail.olderLabel) {
		const label = hovered?.type === "older" ? theme.accent(rail.olderLabel) : theme.text(rail.olderLabel);
		compositeCell(screen, rail.olderRect.y, theme.panel(label), rail.olderRect.x, rail.olderRect.width, width);
	} else if (rail.page.count > 1) {
		compositeCell(screen, rail.rect.y - 1, theme.track(TRACK_GLYPH), rail.rect.x, TIMELINE_RAIL_WIDTH, width);
	}

	if (hoveredTick === undefined || hoveredRow === undefined) return screen;
	const turn = turns[hoveredTick];
	const preview = turn?.preview.trim();
	if (!turn || !preview) return screen;

	const maxTextWidth = timelinePreviewTextWidth(scrollback.width);
	const previewLines = wrapTimelinePreview(preview, maxTextWidth);
	if (previewLines.length === 0) return screen;
	const header = stripTerminalSequences(truncateToWidth(timelineCardHeader(turn, options.now ?? Date.now()), maxTextWidth, "…"));
	const lines = [header, ...previewLines];
	const textWidth = Math.max(...lines.map((line) => visibleWidth(line)));
	const cardWidth = textWidth + 4;
	const cardHeight = lines.length + 2;
	if (cardHeight > rail.rect.height || cardWidth + TIMELINE_RAIL_WIDTH + 1 > scrollback.width) return screen;

	const tickY = hoveredRow;
	const cardX = Math.max(scrollback.x, rail.rect.x - cardWidth - 1);
	const cardY = Math.max(
		rail.rect.y,
		Math.min(tickY - Math.floor(cardHeight / 2), rail.rect.y + rail.rect.height - cardHeight),
	);
	const top = theme.panel(theme.dim(`╭${"─".repeat(cardWidth - 2)}╮`));
	const bottom = theme.panel(theme.dim(`╰${"─".repeat(cardWidth - 2)}╯`));
	compositeCell(screen, cardY, top, cardX, cardWidth, width);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const gap = " ".repeat(Math.max(0, textWidth - visibleWidth(line)));
		const body = index === 0 ? theme.dim(line) : theme.text(line);
		const framed = theme.panel(`${theme.dim("│")} ${body}${gap} ${theme.dim("│")}`);
		compositeCell(screen, cardY + 1 + index, framed, cardX, cardWidth, width);
	}
	compositeCell(screen, cardY + cardHeight - 1, bottom, cardX, cardWidth, width);
	return screen;
}

function findScrollBox(box: RuntimeLayoutBox, scrollView: RuntimeScrollView): RuntimeLayoutBox | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children) {
		const match = findScrollBox(child, scrollView);
		if (match) return match;
	}
	return undefined;
}

interface SemanticComponent {
	kind: "user" | "assistant";
	text?: string;
}

function semanticComponents(component: Component | undefined, output: SemanticComponent[] = []): SemanticComponent[] {
	if (!component) return output;
	if (component instanceof UserMessageComponent) {
		const text = (component as unknown as { text?: unknown }).text;
		output.push({ kind: "user", ...(typeof text === "string" ? { text } : {}) });
		return output;
	}
	if (component instanceof AssistantMessageComponent) {
		// AssistantMessageComponent deliberately omits its OSC 133 zone when it
		// owns tool calls (and when it renders no lines). Mirror that validated
		// private behavior or the next user marker would be misclassified.
		const assistant = component as unknown as {
			hasToolCalls?: unknown;
			contentContainer?: { children?: unknown };
		};
		const contentChildren = assistant.contentContainer?.children;
		if (assistant.hasToolCalls !== true && Array.isArray(contentChildren) && contentChildren.length > 0) {
			output.push({ kind: "assistant" });
		}
		return output;
	}
	const children = (component as unknown as { children?: unknown }).children;
	if (Array.isArray(children)) {
		for (const child of children) semanticComponents(child as Component, output);
	}
	return output;
}

function componentMatchesTurn(componentText: string, turn: FullscreenTimelineTurn): boolean {
	if (componentText === turn.renderText) return true;
	if (componentText.length > 0 && turn.renderText.includes(componentText)) return true;
	return false;
}

function promptAnchors(
	scrollView: RuntimeScrollView,
	contentLines: readonly string[],
	turns: readonly FullscreenTimelineTurn[],
): Map<number, number> {
	const markerRows: number[] = [];
	for (let row = 0; row < contentLines.length; row++) {
		if (PROMPT_START.test(contentLines[row] ?? "")) markerRows.push(row);
	}
	const semantics = semanticComponents(scrollView.children?.[0]);
	const renderedUsers: Array<{ row: number; text: string }> = [];
	for (let index = 0; index < Math.min(markerRows.length, semantics.length); index++) {
		const semantic = semantics[index]!;
		if (semantic.kind === "user" && typeof semantic.text === "string") {
			renderedUsers.push({ row: markerRows[index]!, text: semantic.text });
		}
	}

	const anchors = new Map<number, number>();
	let cursor = 0;
	for (const rendered of renderedUsers) {
		let match = -1;
		for (let index = cursor; index < turns.length; index++) {
			if (componentMatchesTurn(rendered.text, turns[index]!)) {
				match = index;
				break;
			}
		}
		if (match < 0) continue;
		anchors.set(match, rendered.row);
		cursor = match + 1;
	}
	return anchors;
}

function readViewportSnapshot(tui: RuntimeTui, turns: readonly FullscreenTimelineTurn[]): ViewportSnapshot | undefined {
	const layout = tui.currentLayout;
	const scrollView = layout?.primaryScrollView;
	if (!layout || !scrollView) return undefined;
	const box = findScrollBox(layout.root, scrollView);
	const contentLines = box?.scrollContentLines;
	if (!box || !contentLines) return undefined;

	const anchors = promptAnchors(scrollView, contentLines, turns);
	const ordered = [...anchors.entries()].sort((left, right) => left[1] - right[1]);
	let active = ordered[0]?.[0];
	for (const [turnIndex, row] of ordered) {
		if (row <= scrollView.scrollTop) active = turnIndex;
	}
	const contentHeight = contentLines.length;
	const maxScrollTop = Math.max(0, contentHeight - box.rect.height);
	const atBottom = scrollView.scrollTop >= maxScrollTop;
	if (atBottom && ordered.length > 0) active = ordered[ordered.length - 1]![0];
	const anchorSignature = ordered.map(([turnIndex, row]) => `${turnIndex}:${row}`).join(",");
	return {
		box,
		scrollView,
		anchors,
		viewport: {
			...(active === undefined ? {} : { active }),
			followingEnd: scrollView.isFollowingEnd,
			scrollTop: scrollView.scrollTop,
			contentHeight,
		},
		signature: `${layout.width}x${layout.height}|${box.rect.x},${box.rect.y},${box.rect.width},${box.rect.height}|${scrollView.scrollTop}/${contentHeight}|follow:${scrollView.isFollowingEnd ? 1 : 0}|${anchorSignature}`,
	};
}

function projectTimelineViewport(viewport: TimelineViewport, turnIndices: readonly number[]): TimelineViewport {
	const { active: branchActive, ...rest } = viewport;
	const active = branchActive === undefined ? -1 : turnIndices.indexOf(branchActive);
	return active < 0 ? rest : { ...rest, active };
}

function overlayRectangles(tui: RuntimeTui, width: number, height: number): { capturing: boolean; rect: TimelineRect }[] {
	const entries = tui.overlayStack;
	const resolve = tui.resolveOverlayLayout;
	if (!Array.isArray(entries) || typeof resolve !== "function") return tui.hasOverlay() ? [{ capturing: true, rect: { x: 0, y: 0, width, height } }] : [];
	const rectangles: { capturing: boolean; rect: TimelineRect }[] = [];
	for (const entry of entries) {
		if (entry.hidden) continue;
		const options = entry.options;
		if (options?.visible && !options.visible(width, height)) continue;
		if (options?.nonCapturing !== true) {
			// Capturing overlays own all input regardless of their visual bounds.
			// Avoid rendering stateful overlay components an extra time merely to
			// compute a rectangle that pointer routing will not use.
			return [{ capturing: true, rect: { x: 0, y: 0, width, height } }];
		}
		const initial = resolve.call(tui, options, 0, width, height);
		let lines = entry.component.render(initial.width);
		if (initial.maxHeight !== undefined && lines.length > initial.maxHeight) lines = lines.slice(0, initial.maxHeight);
		if (lines.length === 0) continue;
		const final = resolve.call(tui, options, lines.length, width, height);
		rectangles.push({
			capturing: false,
			rect: { x: final.col, y: final.row, width: final.width, height: lines.length },
		});
	}
	return rectangles;
}

export class FullscreenTimelineRuntime implements RuntimePatchController {
	private visible = false;
	private installed = false;
	private available = false;
	private failed = false;
	private disposed = false;
	private runtimeTui: RuntimeTui | undefined;
	private theme: TimelineRuntimeTheme = PLAIN_RUNTIME_THEME;
	private lastRail: VerticalTimelineRail | undefined;
	private lastRailTurnIndices: number[] = [];
	private lastSnapshot: ViewportSnapshot | undefined;
	private lastCompositeSignature = "";
	private mouseHover: VerticalTimelineHit | undefined;
	private timelinePressActive = false;
	private keyboardFocus: number | undefined;
	/** An explicitly browsed rail page, valid only while the viewport's active prompt is unchanged. */
	private browse: { page: number; active: number | undefined } | undefined;
	private lastMouse: { x: number; y: number } | undefined;
	private overlayCache: { width: number; height: number; rectangles: { capturing: boolean; rect: TimelineRect }[] } | undefined;
	private hiddenScrollbars = new Map<RuntimeScrollView, "hidden" | "auto" | "always">();

	constructor(private readonly host: TimelineHost) {}

	enable(): boolean {
		if (this.installed) return this.available;
		this.installed = true;
		this.available = installRuntimePatch(this);
		return this.available;
	}

	setTheme(theme: TimelineRuntimeTheme): void {
		this.theme = theme;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) {
			this.mouseHover = undefined;
			this.timelinePressActive = false;
			this.keyboardFocus = undefined;
			this.browse = undefined;
			this.lastRail = undefined;
			this.lastRailTurnIndices = [];
			this.lastSnapshot = undefined;
			this.lastCompositeSignature = "";
			this.lastMouse = undefined;
			this.overlayCache = undefined;
			this.restoreScrollbars();
		}
		this.requestRender();
	}

	wantsRuntime(): boolean {
		return this.visible && this.available && !this.failed && !this.disposed;
	}

	bindRuntimeTui(tui: RuntimeTui): void {
		if (this.runtimeTui === tui) return;
		this.restoreScrollbars();
		this.runtimeTui = tui;
		this.lastRail = undefined;
		this.lastRailTurnIndices = [];
		this.lastSnapshot = undefined;
		this.lastCompositeSignature = "";
		this.mouseHover = undefined;
		this.keyboardFocus = undefined;
		this.browse = undefined;
		this.timelinePressActive = false;
		this.lastMouse = undefined;
		this.overlayCache = undefined;
	}

	step(delta: number): boolean {
		if (
			!this.visible ||
			!this.hasActiveFullscreenRuntime() ||
			!this.lastRail ||
			this.lastRailTurnIndices.length === 0
		) {
			return false;
		}
		const base = this.keyboardFocus ?? this.lastSnapshot?.viewport.active ?? this.host.getSelected();
		let railIndex = this.lastRailTurnIndices.indexOf(base);
		if (railIndex < 0) {
			railIndex = this.lastRailTurnIndices.findIndex((turnIndex) => turnIndex >= base);
			if (railIndex < 0) railIndex = this.lastRailTurnIndices.length - 1;
		}
		const targetRailIndex = Math.min(Math.max(0, railIndex + delta), this.lastRailTurnIndices.length - 1);
		const target = this.lastRailTurnIndices[targetRailIndex] ?? base;
		this.host.select(target);
		this.mouseHover = undefined;
		this.lastMouse = undefined;
		this.keyboardFocus = target;
		this.browse = undefined;
		this.jumpToTurn(target);
		this.requestRender();
		return true;
	}

	handleViewportInput(tui: RuntimeTui, data: string): boolean {
		const event = parseTimelineMouse(data);
		if (!event || !this.lastRail) return false;
		this.lastMouse = { x: event.x, y: event.y };
		const insideRail = timelineRailContains(this.lastRail, event.x, event.y);
		const occluded = this.pointIsOccluded(tui, event.x, event.y);
		const wheel = (event.button & 64) !== 0;
		const motion = (event.button & 32) !== 0;
		const baseButton = event.button & 3;

		if (wheel) {
			if (insideRail && !occluded && this.lastRail.page.count > 1 && (baseButton === 0 || baseButton === 1)) {
				// Over a paged rail the wheel flips pages instead of scrolling the transcript.
				this.showPage(this.lastRail.page.index + (baseButton === 0 ? -1 : 1));
				return true;
			}
			if (this.mouseHover || this.keyboardFocus !== undefined || this.browse) {
				this.mouseHover = undefined;
				this.keyboardFocus = undefined;
				this.browse = undefined;
				this.requestRender();
			}
			return false;
		}
		if (motion) {
			// Preserve Pi's text-selection drag path; only unpressed motion is hover.
			if (baseButton !== 3) return false;
			const hadKeyboardFocus = this.keyboardFocus !== undefined;
			this.keyboardFocus = undefined;
			const next = insideRail && !occluded ? hitVerticalTimelineRail(this.lastRail, event.x, event.y) : undefined;
			if (hadKeyboardFocus || !sameHit(next, this.mouseHover)) {
				this.mouseHover = next;
				this.requestRender();
			}
			return insideRail && !occluded;
		}

		const ownLeftRelease = event.release && baseButton === 0 && this.timelinePressActive;
		if (event.release && baseButton === 0) this.timelinePressActive = false;
		if (!insideRail || occluded) {
			if (!event.release && baseButton === 0) this.timelinePressActive = false;
			if (!event.release && baseButton === 0 && (this.mouseHover || this.keyboardFocus !== undefined)) {
				this.mouseHover = undefined;
				this.keyboardFocus = undefined;
				this.requestRender();
			}
			return ownLeftRelease;
		}
		if (!event.release && baseButton === 0) {
			this.timelinePressActive = true;
			const hit = hitVerticalTimelineRail(this.lastRail, event.x, event.y);
			if (hit?.type === "latest") {
				const turns = this.host.getTurns();
				if (turns.length > 0) this.host.select(turns.length - 1);
				this.keyboardFocus = undefined;
				this.browse = undefined;
				this.lastSnapshot?.scrollView.scrollToEnd();
			} else if (hit?.type === "older") {
				this.showPage(this.lastRail.page.index - 1);
			} else if (hit) {
				const target = this.lastRailTurnIndices[hit.turnIndex];
				if (target !== undefined) {
					this.host.select(target);
					this.keyboardFocus = target;
					this.browse = undefined;
					this.jumpToTurn(target);
				}
			}
			this.requestRender();
			return true;
		}
		// Consume the matching left-button release so Pi does not begin/end a
		// transcript selection beneath the rail. Other buttons keep Pi behavior.
		return ownLeftRelease;
	}

	composite(tui: RuntimeTui, lines: string[], width: number, height: number): string[] {
		const turns = this.host.getTurns();
		const hadRail = this.lastRail !== undefined;
		this.overlayCache = undefined;
		if (width < TIMELINE_MIN_TERMINAL_WIDTH || turns.length < 1) {
			this.lastSnapshot = undefined;
			this.lastRail = undefined;
			this.lastRailTurnIndices = [];
			this.restoreScrollbars();
			this.lastCompositeSignature = "";
			this.requestRailLayoutConvergence(hadRail);
			return lines;
		}
		const snapshot = readViewportSnapshot(tui, turns);
		this.lastSnapshot = snapshot;
		const railTurnIndices = snapshot ? [...snapshot.anchors.keys()].sort((left, right) => left - right) : [];
		if (!snapshot || railTurnIndices.length < 1) {
			this.lastRail = undefined;
			this.lastRailTurnIndices = [];
			this.restoreScrollbars();
			this.lastCompositeSignature = snapshot?.signature ?? "";
			this.requestRailLayoutConvergence(hadRail);
			return lines;
		}

		this.hideScrollbar(snapshot.scrollView);
		if (snapshot.scrollView.isFollowingEnd && turns.length > 0 && this.host.getSelected() !== turns.length - 1) {
			this.host.select(turns.length - 1);
		}
		const railTurns = railTurnIndices.map((turnIndex) => turns[turnIndex]!);
		const railViewport = projectTimelineViewport(snapshot.viewport, railTurnIndices);
		const anchorRows = railTurnIndices.map((turnIndex) => snapshot.anchors.get(turnIndex)!);
		if (this.browse && this.browse.active !== railViewport.active) this.browse = undefined;
		const rail = computeVerticalTimelineRail(snapshot.box.rect, anchorRows, railViewport, this.browse?.page);
		if (!rail) {
			this.lastRail = undefined;
			this.lastRailTurnIndices = [];
			this.restoreScrollbars();
			this.lastCompositeSignature = snapshot.signature;
			this.requestRailLayoutConvergence(hadRail);
			return lines;
		}
		this.lastRail = rail;
		this.lastRailTurnIndices = railTurnIndices;
		this.lastCompositeSignature = snapshot.signature;
		this.requestRailLayoutConvergence(hadRail);

		if (this.lastMouse) {
			const overTimeline = timelineRailContains(rail, this.lastMouse.x, this.lastMouse.y);
			const next = overTimeline && !this.pointIsOccluded(tui, this.lastMouse.x, this.lastMouse.y)
				? hitVerticalTimelineRail(rail, this.lastMouse.x, this.lastMouse.y)
				: undefined;
			this.mouseHover = next;
		}
		const keyboardRailIndex = this.keyboardFocus === undefined ? -1 : railTurnIndices.indexOf(this.keyboardFocus);
		const visualHover =
			this.mouseHover ?? (keyboardRailIndex >= 0 ? { type: "tick" as const, turnIndex: keyboardRailIndex } : undefined);
		return compositeVerticalTimeline(lines, width, snapshot.box.rect, rail, railTurns, visualHover, this.theme, {
			busy: this.host.isBusy?.() === true,
		});
	}

	afterRender(tui: RuntimeTui): void {
		this.overlayCache = undefined;
		if (!this.wantsRuntime()) return;
		const turns = this.host.getTurns();
		if (tui.terminal.columns < TIMELINE_MIN_TERMINAL_WIDTH || turns.length < 1) return;
		const snapshot = readViewportSnapshot(tui, turns);
		if (snapshot && snapshot.signature !== this.lastCompositeSignature) {
			// compositeOverlays sees the previous completed LayoutFrame. One bounded
			// follow-up frame aligns the rail after resize/content-layout changes.
			tui.requestRender();
		}
	}

	runtimeCrashed(): void {
		if (this.failed) return;
		this.failed = true;
		this.mouseHover = undefined;
		this.timelinePressActive = false;
		this.keyboardFocus = undefined;
		this.lastRail = undefined;
		this.lastRailTurnIndices = [];
		this.lastSnapshot = undefined;
		this.lastMouse = undefined;
		this.overlayCache = undefined;
		this.restoreScrollbars();
		this.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.visible = false;
		this.lastRail = undefined;
		this.lastRailTurnIndices = [];
		this.lastSnapshot = undefined;
		this.lastMouse = undefined;
		this.overlayCache = undefined;
		this.restoreScrollbars();
		if (this.installed) uninstallRuntimePatch(this);
		this.runtimeTui = undefined;
	}

	/** Browse a rail page without moving the transcript; the viewport's own page clears the browse. */
	private showPage(page: number): void {
		const rail = this.lastRail;
		if (!rail) return;
		const target = Math.min(Math.max(0, page), rail.page.count - 1);
		const active = this.lastSnapshot ? projectTimelineViewport(this.lastSnapshot.viewport, this.lastRailTurnIndices).active : undefined;
		const activePage = timelinePageOf(this.lastRailTurnIndices.length, rail.page.size, active);
		this.browse = target === activePage ? undefined : { page: target, active };
		this.mouseHover = undefined;
		this.keyboardFocus = undefined;
		this.requestRender();
	}

	private jumpToTurn(turnIndex: number): void {
		const snapshot = this.lastSnapshot ?? (this.runtimeTui ? readViewportSnapshot(this.runtimeTui, this.host.getTurns()) : undefined);
		const row = snapshot?.anchors.get(turnIndex);
		if (row === undefined || !snapshot) return;
		snapshot.scrollView.scrollTo(row, { disableFollow: true });
		this.requestRender();
	}

	private hasActiveFullscreenRuntime(): boolean {
		const runtime = this.runtimeTui as (RuntimeTui & { stopped?: boolean; altScreenActive?: boolean }) | undefined;
		return (
			runtime?.mode === "fullscreen" &&
			runtime.stopped === false &&
			runtime.altScreenActive === true &&
			this.available &&
			!this.failed
		);
	}

	private hideScrollbar(scrollView: RuntimeScrollView): void {
		for (const [other, original] of [...this.hiddenScrollbars]) {
			if (other === scrollView) continue;
			other.setScrollbar(original);
			this.hiddenScrollbars.delete(other);
		}
		const current = scrollView.scrollbar;
		if (
			(current === "hidden" || current === "auto" || current === "always") &&
			(!this.hiddenScrollbars.has(scrollView) || current !== "hidden")
		) {
			// Preserve a setting changed while the timeline is visible, rather than
			// restoring the value that happened to be active when it first opened.
			this.hiddenScrollbars.set(scrollView, current);
		}
		if (scrollView.scrollbar !== "hidden") scrollView.setScrollbar("hidden");
	}

	private restoreScrollbars(): void {
		for (const [scrollView, original] of this.hiddenScrollbars) {
			try {
				scrollView.setScrollbar(original);
			} catch {
				// A renderer replaced during /tui-mode may already be detached.
			}
		}
		this.hiddenScrollbars.clear();
	}

	private pointIsOccluded(tui: RuntimeTui, x: number, y: number): boolean {
		const width = Math.max(1, tui.terminal.columns);
		const height = Math.max(1, tui.terminal.rows);
		if (!this.overlayCache || this.overlayCache.width !== width || this.overlayCache.height !== height) {
			this.overlayCache = { width, height, rectangles: overlayRectangles(tui, width, height) };
		}
		for (const overlay of this.overlayCache.rectangles) {
			if (overlay.capturing || pointInRect(overlay.rect, x, y)) return true;
		}
		return false;
	}

	private requestRailLayoutConvergence(hadRail: boolean): void {
		if (hadRail === (this.lastRail !== undefined)) return;
		// Scrollbar ownership changes after Pi has already rendered the base frame.
		// Repaint once so the native scrollbar disappears or returns immediately.
		this.requestRender();
	}

	requestRender(): void {
		if (!this.runtimeTui) return;
		try {
			this.runtimeTui.requestRender();
		} catch {
			// Renderer switches detach the old TUI; the next frame binds the new one.
		}
	}
}

/**
 * User prompts are plain text, not trusted styled output. Remove every
 * terminal sequence and C0/C1 control while preserving line breaks and tabs;
 * normalize CR/CRLF to LF so carriage returns cannot overprint a preview.
 * Exported for tests.
 */
export function sanitizePromptText(text: string): string {
	return scrubTerminalSequences(text)
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\r\n?/g, "\n");
}

/** Display and exact Pi-render projections in one pass over content blocks. */
function messageTextProjections(content: unknown): { display: string; rendered: string } {
	if (typeof content === "string") return { display: content, rendered: content };
	if (!Array.isArray(content)) return { display: "", rendered: "" };
	const textBlocks: string[] = [];
	for (const part of content) {
		const candidate = part as { type?: unknown; text?: unknown };
		if (candidate?.type === "text" && typeof candidate.text === "string") textBlocks.push(candidate.text);
	}
	return {
		display: textBlocks.filter((text) => text.length > 0).join("\n"),
		// Pi's UserMessageComponent concatenates text blocks without separators.
		rendered: textBlocks.join(""),
	};
}

function entryTimestamp(entry: SessionEntry, message: { timestamp?: unknown }): number | undefined {
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	const recorded = (entry as { timestamp?: unknown }).timestamp;
	if (typeof recorded !== "string") return undefined;
	const parsed = Date.parse(recorded);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function toolCallCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => (part as { type?: unknown })?.type === "toolCall").length;
}

/** Stable branch turns plus the text projections and card metadata used by the fullscreen seam. */
export function extractTimelineTurns(entries: readonly SessionEntry[]): FullscreenTimelineTurn[] {
	const turns: FullscreenTimelineTurn[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown };
		if (message?.role === "assistant") {
			const current = turns[turns.length - 1];
			if (current) current.toolCount += toolCallCount(message.content);
			continue;
		}
		if (message?.role !== "user") continue;
		const projections = messageTextProjections(message.content);
		const text = sanitizePromptText(projections.display);
		const entryId = (entry as { id?: unknown }).id;
		const timestamp = entryTimestamp(entry, message);
		turns.push({
			id: typeof entryId === "string" ? entryId : `turn:${turns.length}`,
			renderText: projections.rendered,
			preview: timelinePromptPreview(text),
			ordinal: turns.length + 1,
			...(timestamp === undefined ? {} : { timestamp }),
			toolCount: 0,
		});
	}
	return turns;
}

export default function timelineExtension(pi: ExtensionAPI) {
	let visible = true;
	let turns: FullscreenTimelineTurn[] = [];
	let selected = 0;
	/** Selection is pinned to the newest turn; new turns keep it there. */
	let followTail = true;
	let busy = false;
	const runtime = new FullscreenTimelineRuntime({
		getTurns: () => turns,
		getSelected: () => selected,
		isBusy: () => busy,
		select: (turnIndex) => {
			if (turns.length === 0) return;
			selected = Math.min(Math.max(0, turnIndex), turns.length - 1);
			followTail = selected === turns.length - 1;
		},
	});

	/** Recompute turns from the active branch and re-apply follow/clamp rules. */
	const refresh = (ctx: ExtensionContext) => {
		const previousId = turns[selected]?.id;
		turns = extractTimelineTurns(ctx.sessionManager.getBranch());
		if (turns.length === 0) {
			selected = 0;
			followTail = true;
		} else if (followTail) {
			selected = turns.length - 1;
		} else {
			const retained = previousId === undefined ? -1 : turns.findIndex((turn) => turn.id === previousId);
			selected = retained >= 0 ? retained : Math.min(selected, turns.length - 1);
		}
	};

	const show = (ctx: ExtensionContext) => {
		visible = true;
		refresh(ctx);
		if (ctx.mode !== "tui") return;
		const theme = ctx.ui.theme;
		runtime.setTheme({
			dim: (text) => theme.fg("dim", text),
			accent: (text) => theme.fg("accent", text),
			text: (text) => theme.fg("text", text),
			panel: (text) => theme.bg("customMessageBg", text),
			track: (text) => theme.fg("scrollbarTrack", text),
			thumb: (text) => theme.fg("scrollbarThumb", text),
		});
		runtime.enable();
		runtime.setVisible(true);
	};

	const hide = () => {
		visible = false;
		runtime.setVisible(false);
	};

	const step = (delta: number) => {
		runtime.step(delta);
	};

	const refreshIfVisible = (ctx: ExtensionContext) => {
		if (!visible) return;
		refresh(ctx);
		runtime.requestRender();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!visible) return;
		if (ctx.mode === "tui") show(ctx);
		else refresh(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => refreshIfVisible(ctx));
	pi.on("agent_start", async (_event, ctx) => {
		busy = true;
		refreshIfVisible(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => refreshIfVisible(ctx));
	pi.on("agent_settled", async (_event, ctx) => {
		busy = false;
		refreshIfVisible(ctx);
	});

	pi.on("session_shutdown", async () => {
		visible = false;
		runtime.dispose();
		turns = [];
		selected = 0;
		followTail = true;
		busy = false;
	});

	pi.registerShortcut("alt+,", {
		description: "Timeline: select previous turn",
		handler: () => step(-1),
	});
	pi.registerShortcut("alt+.", {
		description: "Timeline: select next turn",
		handler: () => step(1),
	});

	pi.registerCommand("timeline", {
		description: "Toggle the default-on vertical fullscreen timeline (alt+, / alt+. step turns)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") return;
			if (visible) hide();
			else show(ctx);
		},
	});
}
