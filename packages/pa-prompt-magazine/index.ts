/**
 * pa-prompt-magazine — multi-slot prompt stash ("magazine") for Prime Agent.
 *
 * The built-in Ctrl+S stash holds exactly one draft. This extension adds a
 * FIFO queue of drafts ("the magazine") with a natural capture flow for the
 * "typed a long draft but don't want to send it yet" case:
 *
 *   Type your draft (multi-line is fine), end the last line with `;;`,
 *   press Enter. The whole draft is intercepted and stashed into the
 *   magazine instead of being sent. (`;;;` escapes to a literal `;;` send.)
 *
 *   /magazine           interactive queue browser: restore / peek / delete /
 *                       reorder / clear
 *   /magazine-clear     clear the whole magazine with confirmation
 *   /stash <text>       programmatic entry point (scripts/RPC); the
 *                       interactive capture path is the `;;` marker above
 *
 * Restoring pops the draft out of the queue and puts it back into the prompt
 * editor; if you then decide not to send it, add `;;` and submit again to
 * push it back onto the queue.
 *
 * Widget: when the magazine is non-empty, a widget above the prompt bar shows
 * the count and one preview row per stash (front entry marked with ▸).
 *
 * Persistence: per-session custom entries via pi.appendEntry — survives
 * restart/resume and follows the session tree branch. Text-only: pasted
 * images are not preserved (the built-in stash's paste snapshots are not
 * reachable through the extension API).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearMagazine,
  countMagazine,
  createMagazineState,
  moveEntry,
  opChangesState,
  parseMagazine,
  parseOp,
  parseStashIntent,
  previewLine,
  pushStash,
  removeAt,
  replayMagazine,
  serializeOp,
  serializeSnapshot,
  SNAPSHOT_EVERY,
  type MagazineOp,
  type MagazineState,
} from "./magazine.ts";

const CUSTOM_TYPE = "pa-prompt-magazine";
const WIDGET_KEY = "pa-prompt-magazine";
/** Preview rows shown in the widget (client caps widgets at 10 lines total). */
const WIDGET_MAX_ROWS = 8;

export default function promptMagazine(pi: ExtensionAPI): void {
  // In-memory queue, reconstructed from the session's custom entries.
  let state: MagazineState = createMagazineState();

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** All persisted records for this session, in append order. */
  function collectRecords(ctx: ExtensionContext): unknown[] {
    const records: unknown[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        records.push(entry.data);
      }
    }
    return records;
  }

  function restoreFromSession(ctx: ExtensionContext): MagazineState {
    return replayMagazine(collectRecords(ctx));
  }

  /** Mutations since the last snapshot anchor (in-memory; correctness does not depend on it). */
  let mutationsSinceSnapshot = 0;

  /**
   * Persist one queue mutation as a compact op record; anchor with a snapshot
   * periodically. `before` must be the queue state BEFORE the mutation so the
   * no-op check sees the same state the op was computed against.
   */
  function persistOp(op: MagazineOp, before: MagazineState): void {
    if (!opChangesState(before, op)) return;
    pi.appendEntry(CUSTOM_TYPE, serializeOp(op));
    mutationsSinceSnapshot++;
    if (mutationsSinceSnapshot >= SNAPSHOT_EVERY) {
      pi.appendEntry(CUSTOM_TYPE, serializeSnapshot(state));
      mutationsSinceSnapshot = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Widget
  // -------------------------------------------------------------------------

  function widgetLines(): string[] {
    const n = countMagazine(state);
    if (n === 0) return [];
    const lines = [`Magazine: ${n} stashed`];
    const shown = Math.min(n, WIDGET_MAX_ROWS);
    for (let i = 0; i < shown; i++) {
      const entry = state.queue[i];
      const marker = i === 0 ? "▸" : "·";
      lines.push(`${marker} #${i + 1} ${previewLine(entry.text, 72)}`);
    }
    if (n > shown) lines.push(`… ${n - shown} more`);
    return lines;
  }

  function refreshWidget(ctx: ExtensionContext): void {
    const lines = widgetLines();
    ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
  }

  // -------------------------------------------------------------------------
  // State restoration
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    state = restoreFromSession(ctx);
    refreshWidget(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreFromSession(ctx);
    refreshWidget(ctx);
  });

  // -------------------------------------------------------------------------
  // Stash helpers
  // -------------------------------------------------------------------------

  function stashText(ctx: ExtensionContext, text: string): void {
    const before = state;
    const result = pushStash(state, text);
    state = result.state;
    persistOp({ kind: "add", text }, before);
    refreshWidget(ctx);
    ctx.ui.notify(
      result.dropped
        ? "Stashed — magazine full, oldest draft dropped"
        : `Stashed into magazine — ${countMagazine(state)} in queue (/magazine to restore)`,
      "info",
    );
  }

  /** Pop the draft at `index` (0-based) out of the queue into the editor. */
  function popToEditor(ctx: ExtensionContext, index: number): boolean {
    const before = state;
    const result = removeAt(state, index);
    state = result.state;
    if (result.entry === undefined) {
      ctx.ui.notify("Magazine is empty", "info");
      return false;
    }
    ctx.ui.setEditorText(result.entry.text);
    persistOp({ kind: "remove", index }, before);
    refreshWidget(ctx);
    ctx.ui.notify(`Restored #${index + 1} — ${countMagazine(state)} left in magazine`, "info");
    return true;
  }

  // -------------------------------------------------------------------------
  // Capture: draft ending with `;;` is stashed instead of sent
  // -------------------------------------------------------------------------

  pi.on("input", async (event, ctx) => {
    // Only intercept interactive submissions; RPC/script/extension inputs pass.
    if (event.source !== "interactive") {
      return { action: "continue" };
    }
    const intent = parseStashIntent(event.text);
    if (intent.kind === "stash") {
      stashText(ctx, intent.text);
      return { action: "handled" };
    }
    if (intent.kind === "send") {
      return { action: "transform", text: intent.text };
    }
    return { action: "continue" };
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Interactive queue browser built on select/confirm/editor dialogs (work in daemon CLI). */
  async function openMagazineBrowser(ctx: ExtensionContext): Promise<void> {
    for (;;) {
      const n = countMagazine(state);
      if (n === 0) {
        ctx.ui.notify("Magazine is empty", "info");
        return;
      }
      const stashOptions = state.queue.map((entry, i) => {
        const marker = i === 0 ? "▸" : " ";
        return `${marker} #${i + 1}  ${previewLine(entry.text, 64)}`;
      });
      stashOptions.push(`─ Clear all (${n}) ─`);
      const choice = await ctx.ui.select(
        `Magazine — ${n} stashed\n↑↓ navigate · Enter select · Esc close`,
        stashOptions,
      );
      if (choice === undefined) return;

      const stashIndex = stashOptions.indexOf(choice);
      if (stashIndex >= n) {
        const ok = await ctx.ui.confirm("Clear magazine?", `Delete all ${n} stashed drafts?`);
        if (!ok) continue;
        const before = state;
        state = clearMagazine();
        persistOp({ kind: "clear" }, before);
        refreshWidget(ctx);
        ctx.ui.notify("Magazine cleared", "info");
        return;
      }

      const entry = state.queue[stashIndex];
      const action = await ctx.ui.select(
        `Stash #${stashIndex + 1}\n${previewLine(entry.text, 60)}`,
        ["Restore to editor", "Peek full text", "Move up", "Move down", "Delete", "← Back"],
      );
      switch (action) {
        case "Restore to editor": {
          popToEditor(ctx, stashIndex);
          return;
        }
        case "Peek full text":
          await ctx.ui.editor(`Stash #${stashIndex + 1} (Esc to close)`, entry.text);
          continue;
        case "Move up": {
          const before = state;
          state = moveEntry(state, stashIndex, stashIndex - 1);
          persistOp({ kind: "move", from: stashIndex, to: stashIndex - 1 }, before);
          refreshWidget(ctx);
          continue;
        }
        case "Move down": {
          const before = state;
          state = moveEntry(state, stashIndex, stashIndex + 1);
          persistOp({ kind: "move", from: stashIndex, to: stashIndex + 1 }, before);
          refreshWidget(ctx);
          continue;
        }
        case "Delete": {
          const before = state;
          const result = removeAt(state, stashIndex);
          state = result.state;
          persistOp({ kind: "remove", index: stashIndex }, before);
          refreshWidget(ctx);
          ctx.ui.notify(`Deleted #${stashIndex + 1} — ${countMagazine(state)} left`, "info");
          continue;
        }
        default:
          continue; // "← Back" or cancelled
      }
    }
  }

  pi.registerCommand("magazine", {
    description:
      "Pop the Nth draft into the editor (/magazine <n>), or open the queue browser without an argument.",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg !== "") {
        const index = Number.parseInt(arg, 10);
        if (Number.isInteger(index) && index >= 1) {
          popToEditor(ctx, index - 1);
          return;
        }
        ctx.ui.notify(`/magazine <n>: n must be a positive number (got "${arg}")`, "info");
        return;
      }
      await openMagazineBrowser(ctx);
    },
  });


  pi.registerCommand("magazine-clear", {
    description: "Clear all stashed drafts from the magazine (with confirmation).",
    handler: async (_args, ctx) => {
      const n = countMagazine(state);
      if (n === 0) {
        ctx.ui.notify("Magazine is empty", "info");
        return;
      }
      const ok = await ctx.ui.confirm("Clear magazine?", `Delete all ${n} stashed drafts?`);
      if (!ok) return;
      const before = state;
      state = clearMagazine();
      persistOp({ kind: "clear" }, before);
      refreshWidget(ctx);
      ctx.ui.notify("Magazine cleared", "info");
    },
  });

  pi.registerCommand("stash", {
    description:
      "Programmatic stash entry point: /stash <text> pushes a draft into the magazine queue. Interactive capture uses the ;; marker instead.",
    handler: async (args, ctx) => {
      const text = (args ?? "").trimEnd();
      if (!text.trim()) {
        ctx.ui.notify("Nothing to stash — /stash <text> or end your draft with ;;", "info");
        return;
      }
      stashText(ctx, text);
    },
  });
}
