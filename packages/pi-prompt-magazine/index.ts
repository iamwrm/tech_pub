/**
 * pi-prompt-magazine — multi-slot prompt stash ("magazine") for Pi.
 *
 * End an interactive TUI draft with `;;` to commit it to the magazine instead
 * of sending it. Bare `;;` opens the browser; `;;;` escapes to a literal `;;`
 * send.
 *
 *   /magazine           browse / restore / peek / move / delete / clear
 *   /magazine-clear     clear with confirmation
 *   /magazine-recover   recover an orphaned same-project magazine
 *   /stash <text>       programmatic command entry point
 *
 * Persisted sessions use one WAL-mode SQLite row per (cwd, Pi session ID).
 * Reload/resume/restart reconstruct the widget from SQLite; persisted forks
 * copy the parent queue once and then diverge. `--no-session` remains entirely
 * in memory, with process-local handoff across reload and in-memory fork.
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import {
  clearMagazine,
  countMagazine,
  createMagazineState,
  moveEntry,
  parseStashIntent,
  previewLine,
  pushStash,
  removeAt,
  type MagazineState,
} from "./magazine.ts";
import {
  MAGAZINE_DATABASE_FILENAME,
  MagazineStorage,
  type MagazineMutation,
  type MagazineSessionIdentity,
  type StoredMagazine,
} from "./storage.ts";
import { MagazineOrderMode } from "./order-mode.ts";

const WIDGET_KEY = "pi-prompt-magazine";
const WIDGET_MAX_ROWS = 8;
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const EPHEMERAL_HANDOFF_KEY = "__piPromptMagazineEphemeralHandoffV1__";

export interface PromptMagazineOptions {
  /** Override used by tests and isolated deployments. */
  databasePath?: string;
  /** Set to zero to disable cross-process widget polling. */
  refreshIntervalMs?: number;
}

interface AppliedMutation<T> {
  state: MagazineState;
  value: T;
  changed: boolean;
}

interface EphemeralHandoffs {
  bySession: Map<string, MagazineState>;
  forkByCwd: Map<string, MagazineState>;
}

type GlobalWithMagazineHandoffs = typeof globalThis & {
  [EPHEMERAL_HANDOFF_KEY]?: EphemeralHandoffs;
};

function ephemeralHandoffs(): EphemeralHandoffs {
  const host = globalThis as GlobalWithMagazineHandoffs;
  host[EPHEMERAL_HANDOFF_KEY] ??= {
    bySession: new Map<string, MagazineState>(),
    forkByCwd: new Map<string, MagazineState>(),
  };
  return host[EPHEMERAL_HANDOFF_KEY];
}

function copyState(source: MagazineState): MagazineState {
  return { queue: source.queue.map((entry) => ({ ...entry })) };
}

function ephemeralSessionKey(identity: MagazineSessionIdentity): string {
  return `${resolve(identity.cwd)}\0${identity.sessionId}`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

export function activatePromptMagazine(pi: ExtensionAPI, options: PromptMagazineOptions = {}): void {
  let state: MagazineState = createMagazineState();
  let revision = -1;
  let storage: MagazineStorage | undefined;
  let identity: MagazineSessionIdentity | undefined;
  let ephemeral = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshGeneration = 0;

  const databasePath = options.databasePath ?? join(getAgentDir(), MAGAZINE_DATABASE_FILENAME);
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS);

  // -------------------------------------------------------------------------
  // Safe UI helpers
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

  function refreshWidgetBestEffort(ctx: ExtensionContext): void {
    try {
      refreshWidget(ctx);
    } catch {
      // A committed queue update must not be reported as failed merely because
      // its captured UI context has already become stale.
    }
  }

  function safeNotify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // Notification failures never alter capture or persistence semantics.
    }
  }

  function safeSetEditorText(ctx: ExtensionContext, text: string): void {
    try {
      ctx.ui.setEditorText(text);
    } catch {
      // The caller still returns handled, preventing accidental model delivery.
    }
  }

  function notifyStorageError(ctx: ExtensionContext, action: string, error?: unknown): void {
    const detail = error ? `: ${describeError(error)}` : "";
    safeNotify(ctx, `Magazine ${action} failed${detail}`, "error");
  }

  function adoptStored(stored: StoredMagazine): void {
    state = stored.state;
    revision = stored.revision;
  }

  function applyStoredBestEffort(stored: StoredMagazine, ctx: ExtensionContext): void {
    adoptStored(stored);
    refreshWidgetBestEffort(ctx);
  }

  // -------------------------------------------------------------------------
  // Session and SQLite lifecycle
  // -------------------------------------------------------------------------

  function currentIdentity(ctx: ExtensionContext): MagazineSessionIdentity {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
    };
  }

  function forkSourceFile(event: { reason: string; previousSessionFile?: string }, ctx: ExtensionContext): string | undefined {
    if (event.reason === "fork" && event.previousSessionFile) return event.previousSessionFile;
    if (event.reason !== "startup") return undefined;
    const parentSession = ctx.sessionManager.getHeader()?.parentSession;
    return typeof parentSession === "string" && parentSession.length > 0 ? parentSession : undefined;
  }

  function stopRefreshPolling(): void {
    refreshGeneration += 1;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  }

  function closeStorage(): void {
    stopRefreshPolling();
    try {
      storage?.close();
    } catch {
      // Session teardown must remain best-effort.
    }
    storage = undefined;
    identity = undefined;
  }

  function syncFromStorage(ctx: ExtensionContext, notifyOnError = true): boolean {
    if (ephemeral) {
      refreshWidgetBestEffort(ctx);
      return true;
    }
    if (!storage || !identity) {
      if (notifyOnError) notifyStorageError(ctx, "refresh", new Error("storage is unavailable"));
      return false;
    }
    try {
      const stored = storage.load(identity);
      if (!stored) throw new Error(`session ${identity.sessionId} has no database row`);
      if (stored.revision !== revision) applyStoredBestEffort(stored, ctx);
      return true;
    } catch (error) {
      if (notifyOnError) notifyStorageError(ctx, "refresh", error);
      return false;
    }
  }

  function startRefreshPolling(ctx: ExtensionContext): void {
    stopRefreshPolling();
    if (refreshIntervalMs <= 0 || ctx.mode !== "tui" || ephemeral) return;
    const generation = refreshGeneration;
    refreshTimer = setInterval(() => {
      if (generation !== refreshGeneration || !storage || !identity) return;
      try {
        const storedRevision = storage.loadRevision(identity);
        if (storedRevision === undefined) throw new Error("current magazine row disappeared");
        if (storedRevision !== revision) {
          const stored = storage.load(identity);
          if (!stored) throw new Error("current magazine row disappeared");
          adoptStored(stored);
          // Unlike ordinary writes, allow this to throw so stale contexts close
          // the polling connection instead of leaking indefinitely.
          refreshWidget(ctx);
        }
      } catch {
        closeStorage();
      }
    }, refreshIntervalMs);
    refreshTimer.unref?.();
  }

  function restoreEphemeralState(
    event: { reason: string },
    ctx: ExtensionContext,
    sessionIdentity: MagazineSessionIdentity,
  ): MagazineState {
    const handoffs = ephemeralHandoffs();
    if (event.reason === "reload") {
      const key = ephemeralSessionKey(sessionIdentity);
      const handed = handoffs.bySession.get(key);
      handoffs.bySession.delete(key);
      if (handed) return copyState(handed);
    }
    if (event.reason === "fork") {
      const cwd = resolve(ctx.cwd);
      const handed = handoffs.forkByCwd.get(cwd);
      handoffs.forkByCwd.delete(cwd);
      if (handed) return copyState(handed);
    }
    return createMagazineState();
  }

  pi.on("session_start", async (event, ctx) => {
    closeStorage();
    state = createMagazineState();
    revision = -1;
    identity = currentIdentity(ctx);
    const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
      isPersisted?: () => boolean;
    };
    ephemeral = sessionManager.isPersisted
      ? !sessionManager.isPersisted()
      : identity.sessionFile === undefined;

    if (ephemeral) {
      state = restoreEphemeralState(event, ctx, identity);
      revision = 0;
      refreshWidgetBestEffort(ctx);
      return;
    }

    try {
      storage = new MagazineStorage(databasePath);
      const loaded = storage.loadOrCreate(identity, {
        cloneFromSessionFile: forkSourceFile(event, ctx),
      });
      applyStoredBestEffort(loaded, ctx);
      startRefreshPolling(ctx);
    } catch (error) {
      try {
        storage?.close();
      } catch {
        // Keep the original initialization error.
      }
      storage = undefined;
      refreshWidgetBestEffort(ctx);
      notifyStorageError(ctx, "initialization", error);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    // Persisted state is per session, intentionally independent of branches.
    syncFromStorage(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (ephemeral && identity) {
      const handoffs = ephemeralHandoffs();
      if (event.reason === "reload") {
        handoffs.bySession.set(ephemeralSessionKey(identity), copyState(state));
      } else if (event.reason === "fork") {
        handoffs.forkByCwd.set(resolve(ctx.cwd), copyState(state));
      }
    }
    closeStorage();
    ephemeral = false;
  });

  function commitMutation<T>(
    ctx: ExtensionContext,
    mutation: (current: MagazineState) => MagazineMutation<T>,
  ): AppliedMutation<T> | undefined {
    if (ephemeral) {
      try {
        const result = mutation(state);
        if (result.changed) {
          state = result.state;
          revision += 1;
        }
        refreshWidgetBestEffort(ctx);
        return result;
      } catch (error) {
        notifyStorageError(ctx, "in-memory update", error);
        return undefined;
      }
    }

    if (!storage || !identity) {
      notifyStorageError(ctx, "write", new Error("storage is unavailable"));
      return undefined;
    }
    try {
      const committed = storage.mutate(identity, mutation);
      applyStoredBestEffort(committed, ctx);
      return committed;
    } catch (error) {
      notifyStorageError(ctx, "write", error);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Queue mutations
  // -------------------------------------------------------------------------

  function stashText(ctx: ExtensionContext, text: string): boolean {
    const committed = commitMutation(ctx, (current) => {
      const result = pushStash(current, text);
      return {
        state: result.state,
        value: { dropped: result.dropped },
        changed: true,
      };
    });
    if (!committed) return false;

    safeNotify(
      ctx,
      committed.value.dropped
        ? "Stashed — magazine full, oldest draft dropped"
        : `Stashed into magazine — ${countMagazine(committed.state)} in queue (/magazine to restore)`,
      "info",
    );
    return true;
  }

  function popToEditor(
    ctx: ExtensionContext,
    selector: { index: number } | { entryId: string },
  ): boolean {
    const committed = commitMutation(ctx, (current) => {
      const index = "index" in selector
        ? selector.index
        : current.queue.findIndex((entry) => entry.id === selector.entryId);
      const result = removeAt(current, index);
      if (result.entry) {
        // Perform the synchronous handoff while SQLite still owns the write
        // transaction. A UI throw rolls back the removal; a later commit error
        // leaves a harmless duplicate rather than losing the only draft copy.
        ctx.ui.setEditorText(result.entry.text);
      }
      return {
        state: result.state,
        value: { entry: result.entry, index },
        changed: result.entry !== undefined,
      };
    });
    if (!committed) return false;
    if (!committed.value.entry) {
      safeNotify(ctx, "That stash is no longer in the magazine", "info");
      return false;
    }

    safeNotify(
      ctx,
      `Restored #${committed.value.index + 1} — ${countMagazine(committed.state)} left in magazine`,
      "info",
    );
    return true;
  }

  function moveById(ctx: ExtensionContext, entryId: string, delta: -1 | 1): boolean {
    const committed = commitMutation(ctx, (current) => {
      const from = current.queue.findIndex((entry) => entry.id === entryId);
      if (from < 0) return { state: current, value: false, changed: false };
      const next = moveEntry(current, from, from + delta);
      return { state: next, value: next !== current, changed: next !== current };
    });
    if (!committed) return false;
    if (!committed.value && !committed.state.queue.some((entry) => entry.id === entryId)) {
      safeNotify(ctx, "That stash was changed by another Pi process", "info");
    }
    return committed.value;
  }

  function deleteById(ctx: ExtensionContext, entryId: string): boolean {
    const committed = commitMutation(ctx, (current) => {
      const index = current.queue.findIndex((entry) => entry.id === entryId);
      const result = removeAt(current, index);
      return {
        state: result.state,
        value: { entry: result.entry, index },
        changed: result.entry !== undefined,
      };
    });
    if (!committed) return false;
    if (!committed.value.entry) {
      safeNotify(ctx, "That stash was already removed", "info");
      return false;
    }
    safeNotify(ctx, `Deleted #${committed.value.index + 1} — ${countMagazine(committed.state)} left`, "info");
    return true;
  }

  function clearCurrentMagazine(ctx: ExtensionContext, expectedEntryIds: string[]): boolean {
    type ClearResult = { kind: "stale" | "cleared"; count: number };
    const committed = commitMutation<ClearResult>(ctx, (current) => {
      const currentIds = current.queue.map((entry) => entry.id);
      const unchanged =
        currentIds.length === expectedEntryIds.length &&
        currentIds.every((entryId, index) => entryId === expectedEntryIds[index]);
      if (!unchanged) {
        return { state: current, value: { kind: "stale" as const, count: current.queue.length }, changed: false };
      }
      return {
        state: clearMagazine(),
        value: { kind: "cleared" as const, count: current.queue.length },
        changed: current.queue.length > 0,
      };
    });
    if (!committed) return false;
    if (committed.value.kind === "stale") {
      safeNotify(ctx, "Magazine changed while confirmation was open; review it and try again", "info");
      return false;
    }
    if (committed.value.count === 0) {
      safeNotify(ctx, "Magazine is already empty", "info");
      return false;
    }
    safeNotify(ctx, "Magazine cleared", "info");
    return true;
  }

  // -------------------------------------------------------------------------
  // Capture: only an interactive TUI draft ending with `;;` is intercepted
  // -------------------------------------------------------------------------

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || ctx.mode !== "tui") return { action: "continue" };

    const intent = parseStashIntent(event.text);
    if (intent.kind === "stash") {
      let committed = false;
      try {
        committed = stashText(ctx, intent.text);
      } catch (error) {
        notifyStorageError(ctx, "capture", error);
      }
      if (!committed) safeSetEditorText(ctx, event.text);
      // This return is unconditional: UI/reporting failures must never turn a
      // stash-intent prompt into model input.
      return { action: "handled" };
    }
    if (intent.kind === "open") {
      if (event.images && event.images.length > 0) return { action: "continue" };
      try {
        await openMagazineBrowser(ctx);
      } catch (error) {
        notifyStorageError(ctx, "browser", error);
      }
      // Bare `;;` is a UI command. Never let a dialog/rendering failure send it
      // to the model as an ordinary prompt.
      return { action: "handled" };
    }
    if (intent.kind === "send") return { action: "transform", text: intent.text };
    return { action: "continue" };
  });

  // -------------------------------------------------------------------------
  // Interactive browser and commands
  // -------------------------------------------------------------------------

  async function openMagazineOrderMode(ctx: ExtensionContext, initialEntryId: string): Promise<void> {
    if (ctx.mode !== "tui") {
      safeNotify(ctx, "Magazine order mode is available in the TUI", "info");
      return;
    }
    if (!syncFromStorage(ctx)) return;
    if (!state.queue.some((entry) => entry.id === initialEntryId)) {
      safeNotify(ctx, "That stash is no longer in the magazine", "info");
      return;
    }

    try {
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const orderMode = new MagazineOrderMode({
          getEntries: () => state.queue,
          initialEntryId,
          onMove: (entryId, delta) => moveById(ctx, entryId, delta),
          onClose: () => done(undefined),
          theme,
          maxVisibleRows: Math.max(3, Math.min(12, tui.terminal.rows - 8)),
        });
        return {
          render: (width) => orderMode.render(width),
          invalidate: () => orderMode.invalidate(),
          handleInput: (data) => {
            orderMode.handleInput(data);
            tui.requestRender();
          },
        };
      });
    } catch (error) {
      notifyStorageError(ctx, "order mode", error);
    }
  }

  async function openMagazineBrowser(ctx: ExtensionContext): Promise<void> {
    for (;;) {
      if (!syncFromStorage(ctx)) return;
      const n = countMagazine(state);
      if (n === 0) {
        safeNotify(ctx, "Magazine is empty", "info");
        return;
      }

      const visibleEntries = [...state.queue];
      const stashOptions = visibleEntries.map((entry, i) => {
        const marker = i === 0 ? "▸" : " ";
        return `${marker} #${i + 1}  ${previewLine(entry.text, 64)}`;
      });
      stashOptions.push(`─ Clear all (${n}) ─`);
      const choice = await ctx.ui.select(
        `Magazine — ${n} stashed\n↑↓ navigate · Enter select · Esc close`,
        stashOptions,
      );
      if (choice === undefined) return;

      const selectedIndex = stashOptions.indexOf(choice);
      if (selectedIndex >= visibleEntries.length) {
        const ok = await ctx.ui.confirm("Clear magazine?", `Delete all ${n} stashed drafts?`);
        if (!ok) continue;
        clearCurrentMagazine(ctx, visibleEntries.map((entry) => entry.id));
        return;
      }

      const selected = visibleEntries[selectedIndex];
      const action = await ctx.ui.select(
        `Stash #${selectedIndex + 1}\n${previewLine(selected.text, 60)}`,
        ["Restore to editor", "Peek full text", "Enter order mode", "Delete", "← Back"],
      );
      switch (action) {
        case "Restore to editor":
          popToEditor(ctx, { entryId: selected.id });
          return;
        case "Peek full text":
          await ctx.ui.editor(`Stash #${selectedIndex + 1} (Esc to close)`, selected.text);
          continue;
        case "Enter order mode":
          await openMagazineOrderMode(ctx, selected.id);
          return;
        case "Delete":
          deleteById(ctx, selected.id);
          continue;
        default:
          continue;
      }
    }
  }

  async function recoverOrphanedMagazine(ctx: ExtensionContext): Promise<void> {
    if (ephemeral) {
      safeNotify(ctx, "Orphan recovery requires a persisted Pi session", "info");
      return;
    }
    if (!storage || !identity) {
      notifyStorageError(ctx, "recovery", new Error("storage is unavailable"));
      return;
    }
    if (!syncFromStorage(ctx)) return;
    if (state.queue.length > 0) {
      safeNotify(ctx, "Clear or restore the current magazine before recovering another one", "info");
      return;
    }

    try {
      const candidates = storage.listRecoverable(identity.cwd, identity.sessionId);
      if (candidates.length === 0) {
        safeNotify(ctx, "No orphaned magazines found for this working directory", "info");
        return;
      }
      const labels = candidates.map((candidate, index) => {
        const when = new Date(candidate.updatedAt).toLocaleString();
        const safeSessionId = previewLine(candidate.sessionId, 36);
        return `#${index + 1} · ${when} · ${candidate.state.queue.length} stashed · ${candidate.preview || "(blank first line)"} · ${safeSessionId}`;
      });
      const choice = await ctx.ui.select("Recover orphaned magazine", labels);
      if (choice === undefined) return;
      const selected = candidates[labels.indexOf(choice)];
      if (!selected) return;

      const ok = await ctx.ui.confirm(
        "Recover magazine?",
        `Move ${selected.state.queue.length} stashed draft${selected.state.queue.length === 1 ? "" : "s"} into this session?`,
      );
      if (!ok) return;

      const result = storage.recoverInto(selected, identity);
      if (result.kind === "missing") {
        safeNotify(ctx, "That orphaned magazine is no longer available", "info");
        syncFromStorage(ctx, false);
        return;
      }
      if (result.kind === "source-changed") {
        safeNotify(ctx, "That source magazine changed or became resumable; recovery was cancelled", "info");
        return;
      }
      if (result.kind === "target-not-empty") {
        applyStoredBestEffort(result.magazine, ctx);
        safeNotify(ctx, "Current magazine changed; recovery was not applied", "info");
        return;
      }
      applyStoredBestEffort(result.magazine, ctx);
      safeNotify(ctx, `Recovered ${result.magazine.state.queue.length} stashed drafts`, "info");
    } catch (error) {
      notifyStorageError(ctx, "recovery", error);
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
          popToEditor(ctx, { index: index - 1 });
          return;
        }
        safeNotify(ctx, `/magazine <n>: n must be a positive number (got "${arg}")`, "info");
        return;
      }
      await openMagazineBrowser(ctx);
    },
  });

  pi.registerCommand("magazine-clear", {
    description: "Clear all stashed drafts from the current session's magazine (with confirmation).",
    handler: async (_args, ctx) => {
      if (!syncFromStorage(ctx)) return;
      const visibleEntries = [...state.queue];
      const n = visibleEntries.length;
      if (n === 0) {
        safeNotify(ctx, "Magazine is empty", "info");
        return;
      }
      const ok = await ctx.ui.confirm("Clear magazine?", `Delete all ${n} stashed drafts?`);
      if (!ok) return;
      clearCurrentMagazine(ctx, visibleEntries.map((entry) => entry.id));
    },
  });

  pi.registerCommand("magazine-recover", {
    description: "Recover an orphaned non-empty magazine from this working directory into the current empty session.",
    handler: async (_args, ctx) => {
      await recoverOrphanedMagazine(ctx);
    },
  });

  pi.registerCommand("stash", {
    description:
      "Programmatic stash entry point: /stash <text> pushes a draft into the magazine queue. Interactive capture uses the ;; marker instead.",
    handler: async (args, ctx) => {
      const text = (args ?? "").trimEnd();
      if (!text.trim()) {
        safeNotify(ctx, "Nothing to stash — /stash <text> or end your draft with ;;", "info");
        return;
      }
      stashText(ctx, text);
    },
  });
}

export default function promptMagazine(pi: ExtensionAPI): void {
  activatePromptMagazine(pi);
}
