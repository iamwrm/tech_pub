/**
 * Standalone mirror of iamwrm/piagent-config
 * `packages/ren-public-package/0014-timeline.ts` (the source of truth, where it
 * ships with tests). This vertical-only fullscreen timeline is self-contained
 * and can be copied alone into agent_extensions.
 * Try it without installing: `pi -e ./0014-timeline.ts`
 *
 * Inlined: scrubTerminalSequences from 0013 plus the fullscreen rail.
 */

import {
	AssistantMessageComponent,
	UserMessageComponent,
	VERSION,
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

export const SUPPORTED_TIMELINE_PI_VERSION = "0.84.2";
export const TIMELINE_MIN_TERMINAL_WIDTH = 30;
export const TIMELINE_RAIL_WIDTH = 2;
export const TIMELINE_LATEST_CONTROL_WIDTH = 13;
export const TIMELINE_LATEST_LABEL = "[↓ Latest]";
export const TIMELINE_FOLLOWING_LABEL = "[✓ Following]";
export const TIMELINE_PREVIEW_MAX_CHARS = 120;
export const TIMELINE_PREVIEW_MIN_TEXT_WIDTH = 16;
export const TIMELINE_PREVIEW_MAX_TEXT_WIDTH = 48;

const PATCH_KEY = Symbol.for("ren-public-package.timeline-fullscreen.patch.v1");
const PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

export interface FullscreenTimelineTurn {
	id: string;
	/** Exact text Pi's UserMessageComponent receives (text blocks concatenated). */
	renderText: string;
	preview: string;
}

export interface TimelineRuntimeTheme {
	dim(text: string): string;
	accent(text: string): string;
	text(text: string): string;
	panel(text: string): string;
}

export const PLAIN_RUNTIME_THEME: TimelineRuntimeTheme = {
	dim: (text) => text,
	accent: (text) => text,
	text: (text) => text,
	panel: (text) => text,
};

interface TimelineHost {
	getTurns(): readonly FullscreenTimelineTurn[];
	getSelected(): number;
	select(turnIndex: number): void;
}

export interface TimelineRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type VerticalTimelineHit =
	| { type: "tick"; turnIndex: number }
	| { type: "up" }
	| { type: "down" }
	| { type: "latest" };

export interface VerticalTimelineRail {
	rect: TimelineRect;
	window: { start: number; end: number };
	ticksY: number;
	upY: number;
	downY: number;
	latestRect: TimelineRect;
	active?: number;
	upTarget?: number;
	downTarget?: number;
	followingEnd: boolean;
}

interface TimelineViewport {
	active?: number;
	upTarget?: number;
	downTarget?: number;
	atBottom: boolean;
	followingEnd: boolean;
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
	if (process.env.PI_TIMELINE_FULLSCREEN_PATCH === "0" || VERSION !== SUPPORTED_TIMELINE_PI_VERSION) return false;

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

export function computeVerticalTimelineRail(
	scrollback: TimelineRect,
	turnCount: number,
	viewport: TimelineViewport,
): VerticalTimelineRail | undefined {
	if (turnCount < 1 || scrollback.width < TIMELINE_LATEST_CONTROL_WIDTH || scrollback.height < 4) return undefined;
	const maxTicks = scrollback.height - 3;
	let start = 0;
	if (turnCount > maxTicks) {
		const tailStart = turnCount - maxTicks;
		if (viewport.atBottom) start = tailStart;
		else start = Math.min(Math.max(0, (viewport.active ?? turnCount - 1) - Math.floor(maxTicks / 2)), tailStart);
	}
	const end = Math.min(turnCount, start + maxTicks);
	const totalRows = end - start + 3;
	const top = scrollback.y + Math.floor((scrollback.height - totalRows) / 2);
	const downY = top + 1 + (end - start);
	return {
		rect: {
			x: scrollback.x + scrollback.width - TIMELINE_RAIL_WIDTH,
			y: scrollback.y,
			width: TIMELINE_RAIL_WIDTH,
			height: scrollback.height,
		},
		window: { start, end },
		ticksY: top + 1,
		upY: top,
		downY,
		latestRect: {
			x: scrollback.x + scrollback.width - TIMELINE_LATEST_CONTROL_WIDTH,
			y: downY + 1,
			width: TIMELINE_LATEST_CONTROL_WIDTH,
			height: 1,
		},
		...(viewport.active === undefined ? {} : { active: viewport.active }),
		...(viewport.upTarget === undefined ? {} : { upTarget: viewport.upTarget }),
		...(viewport.downTarget === undefined ? {} : { downTarget: viewport.downTarget }),
		followingEnd: viewport.followingEnd === true,
	};
}

export function hitVerticalTimelineRail(rail: VerticalTimelineRail, x: number, y: number): VerticalTimelineHit | undefined {
	if (pointInRect(rail.latestRect, x, y)) return { type: "latest" };
	if (x < rail.rect.x || x >= rail.rect.x + rail.rect.width || y < rail.rect.y || y >= rail.rect.y + rail.rect.height) {
		return undefined;
	}
	if (y === rail.upY) return { type: "up" };
	if (y === rail.downY) return { type: "down" };
	const relative = y - rail.ticksY;
	if (relative >= 0 && relative < rail.window.end - rail.window.start) {
		return { type: "tick", turnIndex: rail.window.start + relative };
	}
	return undefined;
}

function sameHit(left: VerticalTimelineHit | undefined, right: VerticalTimelineHit | undefined): boolean {
	if (!left || !right) return left === right;
	return left.type === right.type && (left.type !== "tick" || right.type !== "tick" || left.turnIndex === right.turnIndex);
}

function hitTarget(rail: VerticalTimelineRail, hit: VerticalTimelineHit): number | undefined {
	if (hit.type === "tick") return hit.turnIndex;
	if (hit.type === "latest") return undefined;
	return hit.type === "up" ? rail.upTarget : rail.downTarget;
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

/** Two-thirds-width hover card, bounded by its cap and the rail-side gap. */
export function timelinePreviewTextWidth(scrollbackWidth: number): number {
	const width = Math.max(1, Math.floor(scrollbackWidth));
	const available = Math.max(1, width - 5); // four frame columns plus one rail gap
	const responsive = Math.max(TIMELINE_PREVIEW_MIN_TEXT_WIDTH, Math.floor((width * 2) / 3));
	return Math.max(1, Math.min(TIMELINE_PREVIEW_MAX_TEXT_WIDTH, responsive, available));
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
): string[] {
	const screen = [...input];
	while (screen.length < scrollback.y + scrollback.height) screen.push("");

	const upEnabled = rail.upTarget !== undefined;
	const downEnabled = rail.downTarget !== undefined;
	const up = hovered?.type === "up" && upEnabled ? theme.text(" ▴") : upEnabled ? theme.dim(" ▴") : theme.dim("  ");
	const down =
		hovered?.type === "down" && downEnabled ? theme.text(" ▾") : downEnabled ? theme.dim(" ▾") : theme.dim("  ");
	compositeCell(screen, rail.upY, up, rail.rect.x, TIMELINE_RAIL_WIDTH, width);
	compositeCell(screen, rail.downY, down, rail.rect.x, TIMELINE_RAIL_WIDTH, width);
	const latestLabel = rail.followingEnd ? TIMELINE_FOLLOWING_LABEL : TIMELINE_LATEST_LABEL;
	const latestPadding = " ".repeat(Math.max(0, rail.latestRect.width - visibleWidth(latestLabel)));
	const latestText = rail.followingEnd
		? theme.dim(latestLabel)
		: hovered?.type === "latest"
			? theme.accent(latestLabel)
			: theme.text(latestLabel);
	compositeCell(
		screen,
		rail.latestRect.y,
		theme.panel(`${latestPadding}${latestText}`),
		rail.latestRect.x,
		rail.latestRect.width,
		width,
	);

	for (let turnIndex = rail.window.start; turnIndex < rail.window.end; turnIndex++) {
		const row = rail.ticksY + turnIndex - rail.window.start;
		const isActive = rail.active === turnIndex;
		const isHovered = hovered?.type === "tick" && hovered.turnIndex === turnIndex;
		const tick = isActive ? theme.accent("━━") : isHovered ? theme.text("──") : theme.dim(" ─");
		compositeCell(screen, row, tick, rail.rect.x, TIMELINE_RAIL_WIDTH, width);
	}

	if (hovered?.type !== "tick" || !rail.window || hovered.turnIndex < rail.window.start || hovered.turnIndex >= rail.window.end) {
		return screen;
	}
	const preview = turns[hovered.turnIndex]?.preview.trim();
	if (!preview) return screen;

	const maxTextWidth = timelinePreviewTextWidth(scrollback.width);
	const previewLines = wrapTimelinePreview(preview, maxTextWidth);
	if (previewLines.length === 0) return screen;
	const textWidth = Math.max(...previewLines.map((line) => visibleWidth(line)));
	const cardWidth = textWidth + 4;
	const cardHeight = previewLines.length + 2;
	const previewBottom = rail.latestRect.y;
	if (cardHeight > previewBottom - scrollback.y || cardWidth + 1 > scrollback.width) return screen;

	const tickY = rail.ticksY + hovered.turnIndex - rail.window.start;
	const cardX = Math.max(scrollback.x, rail.rect.x - cardWidth - 1);
	const cardY = Math.max(
		scrollback.y,
		Math.min(tickY - Math.floor(cardHeight / 2), previewBottom - cardHeight),
	);
	const top = theme.panel(theme.dim(`╭${"─".repeat(cardWidth - 2)}╮`));
	const bottom = theme.panel(theme.dim(`╰${"─".repeat(cardWidth - 2)}╯`));
	compositeCell(screen, cardY, top, cardX, cardWidth, width);
	for (let index = 0; index < previewLines.length; index++) {
		const line = previewLines[index]!;
		const gap = " ".repeat(Math.max(0, textWidth - visibleWidth(line)));
		const framed = theme.panel(`${theme.dim("│")} ${theme.text(line)}${gap} ${theme.dim("│")}`);
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
		// owns tool calls (and when it renders no lines). Mirror that private,
		// exact-version behavior or the next user marker would be misclassified.
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
	let upTarget: number | undefined;
	let downTarget: number | undefined;
	if (active !== undefined) {
		for (const [turnIndex] of ordered) {
			if (turnIndex < active) upTarget = turnIndex;
			else if (turnIndex > active && downTarget === undefined) downTarget = turnIndex;
		}
	}
	const anchorSignature = ordered.map(([turnIndex, row]) => `${turnIndex}:${row}`).join(",");
	return {
		box,
		scrollView,
		anchors,
		viewport: {
			...(active === undefined ? {} : { active }),
			...(upTarget === undefined ? {} : { upTarget }),
			...(downTarget === undefined ? {} : { downTarget }),
			atBottom,
			followingEnd: scrollView.isFollowingEnd,
		},
		signature: `${layout.width}x${layout.height}|${box.rect.x},${box.rect.y},${box.rect.width},${box.rect.height}|${scrollView.scrollTop}/${contentHeight}|follow:${scrollView.isFollowingEnd ? 1 : 0}|${anchorSignature}`,
	};
}

function projectTimelineViewport(viewport: TimelineViewport, turnIndices: readonly number[]): TimelineViewport {
	const positions = new Map(turnIndices.map((turnIndex, railIndex) => [turnIndex, railIndex]));
	const active = viewport.active === undefined ? undefined : positions.get(viewport.active);
	const upTarget = viewport.upTarget === undefined ? undefined : positions.get(viewport.upTarget);
	const downTarget = viewport.downTarget === undefined ? undefined : positions.get(viewport.downTarget);
	return {
		...(active === undefined ? {} : { active }),
		...(upTarget === undefined ? {} : { upTarget }),
		...(downTarget === undefined ? {} : { downTarget }),
		atBottom: viewport.atBottom,
		followingEnd: viewport.followingEnd,
	};
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
		this.jumpToTurn(target);
		this.requestRender();
		return true;
	}

	handleViewportInput(tui: RuntimeTui, data: string): boolean {
		const event = parseTimelineMouse(data);
		if (!event || !this.lastRail) return false;
		this.lastMouse = { x: event.x, y: event.y };
		const insideRail =
			pointInRect(this.lastRail.rect, event.x, event.y) || pointInRect(this.lastRail.latestRect, event.x, event.y);
		const occluded = this.pointIsOccluded(tui, event.x, event.y);
		const wheel = (event.button & 64) !== 0;
		const motion = (event.button & 32) !== 0;
		const baseButton = event.button & 3;

		if (wheel) {
			if (this.mouseHover || this.keyboardFocus !== undefined) {
				this.mouseHover = undefined;
				this.keyboardFocus = undefined;
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
				this.lastSnapshot?.scrollView.scrollToEnd();
			} else if (hit) {
				const railTarget = hitTarget(this.lastRail, hit);
				const target = railTarget === undefined ? undefined : this.lastRailTurnIndices[railTarget];
				if (target !== undefined) {
					this.host.select(target);
					this.keyboardFocus = target;
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
		const rail = computeVerticalTimelineRail(snapshot.box.rect, railTurns.length, railViewport);
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
			const overTimeline =
				pointInRect(rail.rect, this.lastMouse.x, this.lastMouse.y) ||
				pointInRect(rail.latestRect, this.lastMouse.x, this.lastMouse.y);
			const next = overTimeline && !this.pointIsOccluded(tui, this.lastMouse.x, this.lastMouse.y)
				? hitVerticalTimelineRail(rail, this.lastMouse.x, this.lastMouse.y)
				: undefined;
			this.mouseHover = next;
		}
		const keyboardRailIndex = this.keyboardFocus === undefined ? -1 : railTurnIndices.indexOf(this.keyboardFocus);
		const visualHover = this.mouseHover ??
			(keyboardRailIndex >= rail.window.start && keyboardRailIndex < rail.window.end
				? { type: "tick" as const, turnIndex: keyboardRailIndex }
				: undefined);
		return compositeVerticalTimeline(lines, width, snapshot.box.rect, rail, railTurns, visualHover, this.theme);
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

/** Stable branch turns plus the two text projections needed by the fullscreen seam. */
export function extractTimelineTurns(entries: readonly SessionEntry[]): FullscreenTimelineTurn[] {
	const turns: FullscreenTimelineTurn[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		if (message?.role !== "user") continue;
		const projections = messageTextProjections(message.content);
		const text = sanitizePromptText(projections.display);
		const entryId = (entry as { id?: unknown }).id;
		turns.push({
			id: typeof entryId === "string" ? entryId : `turn:${turns.length}`,
			renderText: projections.rendered,
			preview: timelinePromptPreview(text),
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
	const runtime = new FullscreenTimelineRuntime({
		getTurns: () => turns,
		getSelected: () => selected,
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
	pi.on("agent_start", async (_event, ctx) => refreshIfVisible(ctx));
	pi.on("turn_end", async (_event, ctx) => refreshIfVisible(ctx));
	pi.on("agent_settled", async (_event, ctx) => refreshIfVisible(ctx));

	pi.on("session_shutdown", async () => {
		visible = false;
		runtime.dispose();
		turns = [];
		selected = 0;
		followTail = true;
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
