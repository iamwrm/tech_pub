/**
 * pa-prompt-magazine — pure queue model for the prompt "magazine".
 *
 * No prime-agent imports here on purpose: the model is unit-testable with
 * plain Node, and the extension layer (index.ts) only adapts it to the
 * Prime Agent API.
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
 * Storage (op log): every mutation is persisted as a small op record
 * ({kind:"add"|"remove"|"move"|"clear"}) instead of a full queue snapshot.
 * Every SNAPSHOT_EVERY mutations a full snapshot anchor is appended so
 * replayMagazine never has to replay a long log. Legacy full-snapshot
 * payloads ({queue: [...]}) are still recognized as snapshots.
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
  | { kind: "none" };

/**
 * Decide what a submitted draft means.
 *
 * - ends with `;;;`            -> "send": strip one semicolon, send normally
 *                                  (escape hatch for drafts ending in `;;`)
 * - ends with `;;` (non-empty) -> "stash": strip the marker, intercept
 * - ends with `;;` (empty)     -> "none": bare marker, let it pass
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
    if (clean.length === 0) return { kind: "none" };
    return { kind: "stash", text: clean };
  }
  return { kind: "none" };
}


// ---------------------------------------------------------------------------
// Op log (storage-efficient session persistence)
// ---------------------------------------------------------------------------

/** How often to append a full snapshot anchor (keeps replay bounded). */
export const SNAPSHOT_EVERY = 25;

/** A single queue mutation, replayed in order on restore. */
export type MagazineOp =
  | { kind: "add"; text: string }
  | { kind: "remove"; index: number }
  | { kind: "move"; from: number; to: number }
  | { kind: "clear" };

/** Serialize one op record for pi.appendEntry. */
export function serializeOp(op: MagazineOp): unknown {
  return { v: 2, kind: op.kind, ...(op.kind === "add" ? { text: op.text } : op.kind === "remove" ? { index: op.index } : op.kind === "move" ? { from: op.from, to: op.to } : {}) };
}

/** Apply one op to a queue state (replay semantics). */
export function applyOp(state: MagazineState, op: MagazineOp): MagazineState {
  switch (op.kind) {
    case "add":
      return pushStash(state, op.text).state;
    case "remove":
      return removeAt(state, op.index).state;
    case "move":
      return moveEntry(state, op.from, op.to);
    case "clear":
      return clearMagazine();
  }
}

/** True when the op would actually change the queue (no-op ops are not logged). */
export function opChangesState(state: MagazineState, op: MagazineOp): boolean {
  switch (op.kind) {
    case "add":
      return op.text.trim().length > 0;
    case "remove":
      return op.index >= 0 && op.index < state.queue.length;
    case "move": {
      const n = state.queue.length;
      const from = Math.max(0, Math.min(op.from, n - 1));
      const to = Math.max(0, Math.min(op.to, n - 1));
      return from !== to;
    }
    case "clear":
      return state.queue.length > 0;
  }
}

/** Serialize a full snapshot anchor (queue contents + queue length, no ops). */
export function serializeSnapshot(state: MagazineState): unknown {
  return { v: 2, kind: "snapshot", queue: state.queue };
}

function isSnapshotRecord(data: unknown): data is Record<string, unknown> & { queue: unknown } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const rec = data as Record<string, unknown>;
  if (!("queue" in rec) || !Array.isArray(rec.queue)) return false;
  // legacy full snapshots have no kind; v2 snapshots carry kind:"snapshot"
  return rec.kind === undefined || rec.kind === "snapshot";
}

/** Defensive parse of one op record. Returns undefined for anything else. */
export function parseOp(data: unknown): MagazineOp | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  if (rec.v !== 2 || typeof rec.kind !== "string") return undefined;
  switch (rec.kind) {
    case "add":
      return typeof rec.text === "string" ? { kind: "add", text: rec.text } : undefined;
    case "remove":
      return typeof rec.index === "number" ? { kind: "remove", index: rec.index } : undefined;
    case "move":
      return typeof rec.from === "number" && typeof rec.to === "number"
        ? { kind: "move", from: rec.from, to: rec.to }
        : undefined;
    case "clear":
      return { kind: "clear" };
    default:
      return undefined;
  }
}

/**
 * Rebuild the queue from the session's persisted records.
 *
 * - Finds the LAST snapshot record (v2 kind:"snapshot" or legacy {queue:...})
 *   and replays every op after it.
 * - If no snapshot exists (pure op log), replays all ops from empty.
 * - Malformed records are skipped; never throws.
 */
export function replayMagazine(records: unknown[]): MagazineState {
  let lastSnapshot = -1;
  for (let i = 0; i < records.length; i++) {
    if (isSnapshotRecord(records[i])) lastSnapshot = i;
  }
  let state: MagazineState = createMagazineState();
  const start = lastSnapshot >= 0 ? lastSnapshot + 1 : 0;
  if (lastSnapshot >= 0) {
    state = parseMagazine(records[lastSnapshot]);
  }
  for (let i = start; i < records.length; i++) {
    const op = parseOp(records[i]);
    if (op) state = applyOp(state, op);
  }
  return state;
}

/** Serializable payload for pi.appendEntry custom entries. */
export function serializeMagazine(state: MagazineState): unknown {
  return { queue: state.queue };
}

/** Defensive parse of an appendEntry payload. Never throws; degrades to empty. */
export function parseMagazine(data: unknown): MagazineState {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return createMagazineState();
  }
  const root = data as Record<string, unknown>;
  if (!Array.isArray(root.queue)) return createMagazineState();
  const queue: StashEntry[] = [];
  for (const raw of root.queue) {
    if (typeof raw !== "object" || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.text !== "string") continue;
    queue.push({
      id: typeof rec.id === "string" && rec.id.length > 0 ? rec.id : randomId(),
      text: rec.text,
      createdAt:
        typeof rec.createdAt === "number" && Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
    });
  }
  return { queue: queue.slice(0, MAGAZINE_MAX) };
}

/** First line of a draft, whitespace-collapsed and truncated, for previews. */
export function previewLine(text: string, maxLen = 64): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const collapsed = first.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, Math.max(0, maxLen - 1)) + "…";
}
