/**
 * pi-prompt-magazine — pure queue model for the prompt "magazine".
 *
 * No pi imports here on purpose: the model is unit-testable with plain Node,
 * and the extension layer (index.ts) only adapts it to the pi API.
 *
 * Semantics:
 *   - FIFO queue of stashed drafts. Stashing pushes to the back; restore pops
 *     the selected draft (front for the unload shortcut flows).
 *   - Hard capacity (MAGAZINE_MAX); pushing past the cap drops the oldest
 *     draft so the stash flow is never blocked.
 *   - Entries are immutable snapshots: every mutation returns a new state.
 *
 * Capture marker (parseStashIntent): a submitted draft whose trailing
 * whitespace is followed by `;;` is intercepted and stashed instead of sent.
 * `;;;` escapes to a literal `;;`-terminated send. A bare `;;` (nothing left
 * after stripping) is ignored.
 *
 */

export interface StashEntry {
  id: string;
  text: string;
  createdAt: number;
}

export interface MagazineState {
  queue: StashEntry[];
}

/** Hard cap on stashed drafts; pushing past the cap drops the oldest. */
export const MAGAZINE_MAX = 50;

export function createMagazineState(): MagazineState {
  return { queue: [] };
}

export function randomId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function makeEntry(text: string, now = Date.now(), id?: string): StashEntry {
  return { id: id ?? randomId(), text, createdAt: now };
}

/** Push a draft to the back of the magazine. Drops the oldest when full. */
export function pushStash(
  state: MagazineState,
  text: string,
  now = Date.now(),
): { state: MagazineState; dropped?: StashEntry } {
  const entry = makeEntry(text, now);
  const queue = [...state.queue, entry];
  let dropped: StashEntry | undefined;
  if (queue.length > MAGAZINE_MAX) {
    dropped = queue.shift();
  }
  return { state: { queue }, dropped };
}

/** Pop the front (oldest) draft — the unload action. */
export function popFront(state: MagazineState): { state: MagazineState; entry?: StashEntry } {
  const [entry, ...rest] = state.queue;
  return { state: { queue: rest }, entry };
}

/** Remove the draft at `index`. Out-of-range indexes are a no-op. */
export function removeAt(state: MagazineState, index: number): { state: MagazineState; entry?: StashEntry } {
  if (index < 0 || index >= state.queue.length) {
    return { state, entry: undefined };
  }
  const queue = [...state.queue];
  const [entry] = queue.splice(index, 1);
  return { state: { queue }, entry };
}

/** Move the draft at `from` to `to` (both clamped). No-op when they coincide. */
export function moveEntry(state: MagazineState, from: number, to: number): MagazineState {
  const n = state.queue.length;
  if (n === 0) return state;
  const clampedFrom = Math.max(0, Math.min(from, n - 1));
  const clampedTo = Math.max(0, Math.min(to, n - 1));
  if (clampedFrom === clampedTo) return state;
  const queue = [...state.queue];
  const [entry] = queue.splice(clampedFrom, 1);
  queue.splice(clampedTo, 0, entry);
  return { queue };
}

export function clearMagazine(): MagazineState {
  return createMagazineState();
}

export function countMagazine(state: MagazineState): number {
  return state.queue.length;
}


/** Marker that turns a submitted draft into a stash (see parseStashIntent). */
export const STASH_MARKER = ";;";

export type StashIntent =
  | { kind: "stash"; text: string }
  | { kind: "send"; text: string }
  | { kind: "open" }
  | { kind: "none" };

/**
 * Decide what a submitted draft means.
 *
 * - ends with `;;;`            -> "send": strip one semicolon, send normally
 *                                  (escape hatch for drafts ending in `;;`)
 * - ends with `;;` (non-empty) -> "stash": strip the marker, intercept
 * - bare `;;`                  -> "open": open the magazine browser
 * - anything else              -> "none": normal submission
 *
 * The marker must sit at the very end of the draft (after trailing
 * whitespace); a `;;` in the middle of a multi-line draft is left alone.
 */
export function parseStashIntent(text: string): StashIntent {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(`${STASH_MARKER};`)) {
    return { kind: "send", text: trimmed.slice(0, -1) };
  }
  if (trimmed.endsWith(STASH_MARKER)) {
    const clean = trimmed.slice(0, -STASH_MARKER.length).trimEnd();
    if (clean.length === 0) return { kind: "open" };
    return { kind: "stash", text: clean };
  }
  return { kind: "none" };
}

/** First line of a draft, whitespace-collapsed and truncated, for previews. */
export function previewLine(text: string, maxLen = 64): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  // Drafts are untrusted terminal text. Replace C0/C1 controls (including ESC,
  // BEL, and OSC terminators) before a preview reaches a TUI widget or dialog.
  const safe = first.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const collapsed = safe.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, Math.max(0, maxLen - 1)) + "…";
}
