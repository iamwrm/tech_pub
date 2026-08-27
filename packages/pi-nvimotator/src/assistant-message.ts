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

function normalizedAssistantText(entry: MessageEntry): string | null {
  if (entry.type !== "message" || entry.message?.role !== "assistant") return null;
  if (!Array.isArray(entry.message.content)) return "";
  return (entry.message.content as TextBlock[])
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .replace(/\r\n?/g, "\n");
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
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new SnapshotError(`The latest assistant message is larger than ${MAX_SNAPSHOT_BYTES} bytes.`);
    }
    const lines = text.split("\n");
    if (lines.length > MAX_SNAPSHOT_LINES) {
      throw new SnapshotError(`The latest assistant message has more than ${MAX_SNAPSHOT_LINES} lines.`);
    }
    const messageHash = createHash("sha256").update(text).digest("hex");
    const snapshotId = createHash("sha256")
      .update(sessionId)
      .update("\0")
      .update(entry.id)
      .update("\0")
      .update(messageHash)
      .digest("hex");
    return Object.freeze({
      kind: "message",
      sessionId,
      entryId: entry.id,
      snapshotId,
      messageHash,
      text,
      lines: Object.freeze(lines),
    });
  }
  throw new SnapshotError("No non-empty assistant message was found on the active session branch.");
}
