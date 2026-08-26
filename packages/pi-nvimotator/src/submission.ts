import { createHash } from "node:crypto";
import type { MessageSnapshot } from "./assistant-message.ts";
import { buildWrappedFeedback, type FeedbackWrapper } from "./feedback.ts";
import type { Annotation } from "./protocol.ts";

const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

type Entry = {
  fingerprint: string;
  prompt: string;
  bytes: number;
  state: "rendered" | "scheduled";
};

export class SubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionError";
  }
}

function fingerprint(snapshotId: string, annotations: readonly Annotation[]): string {
  const canonical = annotations.map((annotation) => {
    const anchor = annotation.anchor ? {
      selection: annotation.anchor.selection,
      startLine: annotation.anchor.startLine,
      startByte: annotation.anchor.startByte,
      endLine: annotation.anchor.endLine,
      endByte: annotation.anchor.endByte,
    } : null;
    return annotation.kind === "comment"
      ? { id: annotation.id, kind: annotation.kind, anchor, comment: annotation.comment }
      : { id: annotation.id, kind: annotation.kind, anchor, actionId: annotation.actionId };
  });
  return createHash("sha256").update(JSON.stringify({ snapshotId, annotations: canonical })).digest("hex");
}

export class SubmissionStore {
  private snapshot: MessageSnapshot;
  private readonly entries = new Map<string, Entry>();
  private cacheBytes = 0;
  private readonly wrapper?: FeedbackWrapper;

  constructor(snapshot: MessageSnapshot, wrapper?: FeedbackWrapper) {
    this.snapshot = snapshot;
    this.wrapper = wrapper;
  }

  replaceSnapshot(snapshot: MessageSnapshot): void {
    const unchanged = snapshot.snapshotId === this.snapshot.snapshotId;
    this.snapshot = snapshot;
    if (unchanged) return;
    this.entries.clear();
    this.cacheBytes = 0;
  }

  render(submissionId: string, annotations: readonly Annotation[]): string {
    const digest = fingerprint(this.snapshot.snapshotId, annotations);
    const existing = this.entries.get(submissionId);
    if (existing) {
      if (existing.fingerprint !== digest) throw new SubmissionError("Submission ID was already used for different annotations.");
      return existing.prompt;
    }
    const prompt = buildWrappedFeedback(this.snapshot, annotations, this.wrapper);
    const bytes = Buffer.byteLength(prompt);
    this.makeRoom(bytes);
    this.entries.set(submissionId, { fingerprint: digest, prompt, bytes, state: "rendered" });
    this.cacheBytes += bytes;
    return prompt;
  }

  schedule(
    submissionId: string,
    annotations: readonly Annotation[],
    send: (prompt: string) => void,
  ): { prompt: string; alreadyScheduled: boolean } {
    const prompt = this.render(submissionId, annotations);
    const entry = this.entries.get(submissionId)!;
    if (entry.state === "scheduled") return { prompt, alreadyScheduled: true };
    entry.state = "scheduled";
    try {
      send(prompt);
    } catch (error) {
      entry.state = "rendered";
      throw error;
    }
    return { prompt, alreadyScheduled: false };
  }

  isScheduled(submissionId: string): boolean {
    return this.entries.get(submissionId)?.state === "scheduled";
  }

  private makeRoom(incomingBytes: number): void {
    if (this.entries.size >= MAX_CACHE_ENTRIES || this.cacheBytes + incomingBytes > MAX_CACHE_BYTES) {
      throw new SubmissionError("The live submission cache is full; finish or restart the bridge.");
    }
  }
}
