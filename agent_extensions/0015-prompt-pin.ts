/**
 * Prompt pin: keeps the current user request visible above the editor.
 *
 * Pi's TUI viewport is bottom-anchored — streaming output pushes the user's
 * message up and off screen within one screenful, and once a long answer has
 * scrolled by it is easy to lose track of what was asked. This extension
 * echoes the active request in a widget pinned directly above the editor —
 * during the run and while idle afterwards — so the request and the newest
 * activity share one eyeful:
 *
 *   │ ...model output scrolls...   │
 *   │ ⠏ Working...                 │
 *   │ ▉fix the auth bug in       ▉ │  ← pinned request bubble (capped),
 *   │ ▉login.ts please           ▉ │    user-message background color
 *   │ > _                (editor)  │
 *   │ footer                       │
 *
 * - Rendered as a bubble with the same `userMessageBg` background as user
 *   messages in the transcript, so it reads as "the message being worked
 *   on" and cannot be confused with pi's dim `Steering:`/`Follow-up:`
 *   queued-message lines shown in the same region.
 * - Content is branch-derived truth: the last user message on the active
 *   branch (`ctx.sessionManager.getBranch()`), refreshed on
 *   `session_start`, `session_tree`, and `agent_settled` — so the pin
 *   survives `/reload`, `/tree` rewinds and branch switches, session
 *   resume, and process restart without persisting any extension state.
 * - Live updates: `before_agent_start` pins the new prompt immediately;
 *   user `message_end` pins a steering message the moment it is actually
 *   delivered into context (while merely queued, only pi's own `Steering:`
 *   line shows it).
 * - Capped at PIN_MAX_LINES logical lines (default 6) including a dim
 *   `… (+M more lines)` marker for longer prompts. Each line is also
 *   hard-truncated to MAX_LINE_CHARS characters because pi wraps long
 *   widget lines to the terminal width, which would defeat the row cap.
 * - `PI_PROMPT_PIN_LINES` overrides the cap; `0` disables the extension's
 *   pinning (the /prompt-pin command then reports it as disabled).
 * - `/prompt-pin` toggles pinning at runtime (the pin now occupies rows
 *   permanently, so the toggle is the escape hatch; toggling on re-derives
 *   the pin from the branch immediately).
 *
 * The widget is display-only: nothing here is persisted or sent to the LLM.
 *
 * Standalone mirror of iamwrm/piagent-config
 * `packages/ren-public-package/0015-prompt-pin.ts` (the source of truth,
 * where it ships with unit tests); the only difference is an inlined
 * prompt sanitizer instead of the bundle's shared one.
 * Try it without installing: `pi -e ./0015-prompt-pin.ts`
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/**
 * Strip terminal escape sequences and control characters so pasted prompt
 * text cannot re-program the terminal when echoed into the widget. The
 * bundled original reuses a fuller shared scrubber; this standalone copy
 * inlines a compact equivalent (drops CSI/OSC/DCS/SOS/PM/APC sequences and
 * C0/C1 controls, keeps newlines and tabs, normalizes CRLF).
 */
function sanitizePromptText(text: string): string {
	return text
		.replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|\[[0-9;:?<=>]*[ -\/]*[@-~]?|[ -\/]*[@-~]?)/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "")
		.replace(/\r\n?/g, "\n");
}

/** Widget key registered with ctx.ui.setWidget. Exported for smoke tests. */
export const PIN_WIDGET_KEY = "prompt-pin";

/** Default cap on rendered pin rows, marker line included. */
export const DEFAULT_MAX_LINES = 6;

/**
 * Hard cap per logical line. Pi wraps long widget lines to terminal width,
 * so an untruncated single-line paste could occupy many display rows; at
 * 160 characters a line spans at most two rows on a typical 80+ column
 * terminal.
 */
export const MAX_LINE_CHARS = 160;

/**
 * Resolve the row cap from an env-style value: undefined/blank/invalid →
 * DEFAULT_MAX_LINES, 0 or negative → 0 (disabled). Exported for smoke tests.
 */
export function resolveMaxLines(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_LINES;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) return DEFAULT_MAX_LINES;
	return Math.max(0, parsed);
}

/**
 * Render prompt text into capped plain lines, or null when there is nothing
 * worth pinning. Exported for smoke tests.
 *
 * At most `maxLines` rows are produced. When the prompt has more logical
 * lines than fit, the last row is a `… (+M more lines)` marker (styled via
 * `dim`) and M counts the hidden remainder.
 */
export function formatPinLines(text: string, maxLines: number, dim: (text: string) => string): string[] | null {
	if (maxLines <= 0) return null;
	const sanitized = sanitizePromptText(text).replace(/\t/g, "  ");
	const lines = sanitized.split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	if (lines.length === 0) return null;

	const shownCount = lines.length <= maxLines ? lines.length : Math.max(1, maxLines - 1);
	const out = lines
		.slice(0, shownCount)
		.map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line));
	const hidden = lines.length - shownCount;
	if (hidden > 0) {
		out.push(dim(`… (+${hidden} more ${hidden === 1 ? "line" : "lines"})`));
	}
	return out;
}

/**
 * Extract the text of a user message: string content directly, array
 * content by joining its text blocks. Returns null for non-user messages
 * or messages without text. Exported for smoke tests.
 */
export function extractUserText(message: unknown): string | null {
	const m = message as { role?: unknown; content?: unknown };
	if (m?.role !== "user") return null;
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return null;
	const text = m.content
		.filter((block): block is { type: "text"; text: string } => {
			const b = block as { type?: unknown; text?: unknown };
			return b?.type === "text" && typeof b.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
	return text === "" ? null : text;
}

/**
 * Last user message with non-blank text on the active branch, or null.
 * Exported for smoke tests.
 */
export function lastUserPromptFromBranch(entries: readonly SessionEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const text = extractUserText(entry.message);
		if (text !== null && text.trim() !== "") return text;
	}
	return null;
}

export default function promptPinExtension(pi: ExtensionAPI) {
	const maxLines = resolveMaxLines(process.env.PI_PROMPT_PIN_LINES);
	let enabled = maxLines > 0;
	let pinnedCtx: ExtensionContext | null = null;
	let pinnedText: string | null = null;

	const clearPin = () => {
		if (!pinnedCtx) return;
		try {
			pinnedCtx.ui.setWidget(PIN_WIDGET_KEY, undefined);
		} catch {
			// Session UI may already be gone; nothing to clean up then.
		}
		pinnedCtx = null;
		pinnedText = null;
	};

	const pin = (ctx: ExtensionContext, text: string) => {
		if (!enabled || !ctx.hasUI) return;
		// Probe with identity styling: image-only or blank text keeps the
		// previous pin instead of rendering an empty bubble.
		if (formatPinLines(text, maxLines, (t) => t) === null) return;
		if (pinnedCtx === ctx && pinnedText === text) return;
		ctx.ui.setWidget(
			PIN_WIDGET_KEY,
			(_tui, theme) => {
				const lines = formatPinLines(text, maxLines, (t) => theme.fg("dim", t));
				// Same bubble treatment as transcript user messages so the pin is
				// visually distinct from pi's dim queued-message lines.
				const box = new Box(1, 0, (content) => theme.bg("userMessageBg", content));
				for (const line of lines ?? []) {
					box.addChild(new Text(theme.fg("userMessageText", line), 0, 0));
				}
				return box;
			},
			{ placement: "aboveEditor" },
		);
		pinnedCtx = ctx;
		pinnedText = text;
	};

	/** Re-derive the pin from the active branch (survives reload/tree/resume). */
	const refreshPin = (ctx: ExtensionContext) => {
		if (!enabled || !ctx.hasUI) return;
		const text = lastUserPromptFromBranch(ctx.sessionManager.getBranch());
		if (text === null) clearPin();
		else pin(ctx, text);
	};

	// Branch-derived refresh points: startup/resume (and after /reload, which
	// wipes all extension widgets before re-activating extensions), /tree
	// navigation, and run completion (also correct after aborts).
	pi.on("session_start", async (_event, ctx) => refreshPin(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshPin(ctx));
	pi.on("agent_settled", async (_event, ctx) => refreshPin(ctx));

	// Live updates while a run starts/progresses.
	pi.on("before_agent_start", async (event, ctx) => pin(ctx, event.prompt));
	pi.on("message_end", async (event, ctx) => {
		// Fires when a user message actually enters context — including a
		// steering message the moment it is delivered mid-run (while it is
		// merely queued, pi's own dim `Steering:` line is the only display).
		const text = extractUserText(event.message);
		if (text !== null) pin(ctx, text);
	});

	pi.on("session_shutdown", async () => clearPin());

	pi.registerCommand("prompt-pin", {
		description: "Toggle the pinned-request widget shown above the editor",
		handler: async (_args, ctx) => {
			if (maxLines <= 0) {
				if (ctx.hasUI) ctx.ui.notify("prompt-pin is disabled (PI_PROMPT_PIN_LINES=0)", "info");
				return;
			}
			enabled = !enabled;
			if (enabled) refreshPin(ctx);
			else clearPin();
			if (ctx.hasUI) ctx.ui.notify(`prompt-pin ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
