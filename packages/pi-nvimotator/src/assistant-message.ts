import { createHash } from "node:crypto";

export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_LINES = 10_000;

type TextBlock = { type?: unknown; text?: unknown };
type MessageEntry = {
  id?: unknown;
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
};

export type SnapshotKind = "message" | "file";

export interface MessageSnapshot {
  readonly kind: SnapshotKind;
  readonly sessionId: string;
  readonly entryId: string;
  readonly snapshotId: string;
  readonly messageHash: string;
  readonly text: string;
  readonly lines: readonly string[];
  readonly filePath?: string;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function normalizedAssistantText(entry: MessageEntry): string | null {
  if (entry.type !== "message" || entry.message?.role !== "assistant") return null;
  if (!Array.isArray(entry.message.content)) return "";
  return (entry.message.content as TextBlock[])
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .replace(/\r\n?/g, "\n");
}

export function sanitizeSnapshotEntryId(raw: string): string {
  const trimmed = raw.trim();
  if (ENTRY_ID_PATTERN.test(trimmed) && Buffer.byteLength(trimmed) <= 128) return trimmed;
  return `msg-${createHash("sha256").update(trimmed || "missing").digest("hex").slice(0, 24)}`;
}

export function snapshotFromAssistantText(
  sessionId: string,
  entryId: string,
  text: string,
): MessageSnapshot {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) {
    throw new SnapshotError("No non-empty assistant message was found.");
  }
  const bytes = Buffer.byteLength(normalized);
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotError(`The latest assistant message is larger than ${MAX_SNAPSHOT_BYTES} bytes.`);
  }
  const lines = normalized.split("\n");
  if (lines.length > MAX_SNAPSHOT_LINES) {
    throw new SnapshotError(`The latest assistant message has more than ${MAX_SNAPSHOT_LINES} lines.`);
  }
  const safeEntryId = sanitizeSnapshotEntryId(entryId);
  const messageHash = createHash("sha256").update(normalized).digest("hex");
  const snapshotId = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(safeEntryId)
    .update("\0")
    .update(messageHash)
    .digest("hex");
  return Object.freeze({
    kind: "message",
    sessionId,
    entryId: safeEntryId,
    snapshotId,
    messageHash,
    text: normalized,
    lines: Object.freeze(lines),
  });
}

export function captureLatestAssistantSnapshot(
  branch: readonly unknown[],
  sessionId: string,
): MessageSnapshot {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as MessageEntry;
    const text = normalizedAssistantText(entry);
    if (text === null) continue;
    if (!text.trim()) continue;
    if (typeof entry.id !== "string" || !entry.id) {
      throw new SnapshotError("The latest non-empty assistant message has no valid Pi entry ID.");
    }
    return snapshotFromAssistantText(sessionId, entry.id, text);
  }
  throw new SnapshotError("No non-empty assistant message was found on the active session branch.");
}
