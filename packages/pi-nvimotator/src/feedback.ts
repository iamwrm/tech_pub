import { TextDecoder } from "node:util";
import { loadConfig } from "@plannotator/pi-extension/generated/config.ts";
import {
  getAnnotateFileFeedbackPrompt,
  getAnnotateMessageFeedbackPrompt,
} from "@plannotator/pi-extension/generated/prompts.ts";
import type { MessageSnapshot } from "./assistant-message.ts";
import {
  MAX_EXCERPT_BYTES,
  MAX_PROMPT_BYTES,
  MAX_SELECTED_LINES,
  MAX_TOTAL_EXCERPT_BYTES,
  QUICK_ACTIONS,
  type Annotation,
  type TextAnchor,
} from "./protocol.ts";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackError";
  }
}

const actionSemantics = new Map(QUICK_ACTIONS.map((action) => [action.id, action] as const));

type LineBytes = (oneBasedLine: number) => Buffer;

function cachedLineBytes(snapshot: MessageSnapshot): LineBytes {
  const cache = new Map<number, Buffer>();
  return (oneBasedLine) => {
    let value = cache.get(oneBasedLine);
    if (!value) {
      value = Buffer.from(snapshot.lines[oneBasedLine - 1] ?? "", "utf8");
      cache.set(oneBasedLine, value);
    }
    return value;
  };
}

function decodeSlice(bytes: Buffer, start: number, end: number): string {
  if (start > end || end > bytes.length) throw new FeedbackError("Annotation byte range is outside the selected line.");
  try {
    return fatalDecoder.decode(bytes.subarray(start, end));
  } catch {
    throw new FeedbackError("Annotation columns must fall on UTF-8 character boundaries.");
  }
}

function excerptWithReader(snapshot: MessageSnapshot, anchor: TextAnchor, lineBytes: LineBytes): string {
  if (anchor.startLine < 1 || anchor.endLine > snapshot.lines.length || anchor.endLine < anchor.startLine) {
    throw new FeedbackError("Annotation line range is outside the captured snapshot.");
  }
  if (anchor.endLine - anchor.startLine + 1 > MAX_SELECTED_LINES) {
    throw new FeedbackError(`One annotation cannot span more than ${MAX_SELECTED_LINES} lines.`);
  }

  const first = lineBytes(anchor.startLine);
  const last = lineBytes(anchor.endLine);
  if (anchor.selection === "line" && (anchor.startByte !== 0 || anchor.endByte !== last.length)) {
    throw new FeedbackError("Line selections must cover complete lines.");
  }
  if (anchor.startByte > first.length || anchor.endByte > last.length) {
    throw new FeedbackError("Annotation byte range is outside the selected text.");
  }
  if (anchor.startLine === anchor.endLine) {
    if (anchor.endByte < anchor.startByte) throw new FeedbackError("Annotation end precedes its start.");
    const excerpt = decodeSlice(first, anchor.startByte, anchor.endByte);
    if (Buffer.byteLength(excerpt) > MAX_EXCERPT_BYTES) throw new FeedbackError("Selected excerpt is too large.");
    return excerpt;
  }

  const selected = [decodeSlice(first, anchor.startByte, first.length)];
  for (let line = anchor.startLine + 1; line < anchor.endLine; line += 1) {
    selected.push(snapshot.lines[line - 1] ?? "");
  }
  selected.push(decodeSlice(last, 0, anchor.endByte));
  const excerpt = selected.join("\n");
  if (Buffer.byteLength(excerpt) > MAX_EXCERPT_BYTES) throw new FeedbackError("Selected excerpt is too large.");
  return excerpt;
}

export function excerptForAnchor(snapshot: MessageSnapshot, anchor: TextAnchor): string {
  return excerptWithReader(snapshot, anchor, cachedLineBytes(snapshot));
}

function rangeLabel(anchor: TextAnchor): string {
  const lines = anchor.startLine === anchor.endLine ? `line ${anchor.startLine}` : `lines ${anchor.startLine}-${anchor.endLine}`;
  return anchor.selection === "character" ? `${lines}, bytes ${anchor.startByte}-${anchor.endByte}` : lines;
}

function fence(text: string): string {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    current = character === "`" ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}markdown\n${text}\n${marker}`;
}

function quote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

function isFileSnapshot(snapshot: MessageSnapshot): boolean {
  return snapshot.kind === "file";
}

export function buildRawFeedback(snapshot: MessageSnapshot, annotations: readonly Annotation[]): string {
  let totalExcerptBytes = 0;
  const lineBytes = cachedLineBytes(snapshot);
  const file = isFileSnapshot(snapshot);
  const lines = [
    file ? "# File Feedback" : "# Message Feedback",
    "",
    ...(file
      ? [`File: \`${snapshot.filePath ?? snapshot.entryId}\``, `Snapshot: \`${snapshot.snapshotId}\``]
      : [`Assistant entry: \`${snapshot.entryId}\``, `Snapshot: \`${snapshot.snapshotId}\``]),
    "",
  ];

  annotations.forEach((annotation, index) => {
    lines.push(`## Annotation ${index + 1}${annotation.anchor ? ` — ${rangeLabel(annotation.anchor)}` : " — general"}`, "");
    if (annotation.anchor) {
      const excerpt = excerptWithReader(snapshot, annotation.anchor, lineBytes);
      totalExcerptBytes += Buffer.byteLength(excerpt);
      if (totalExcerptBytes > MAX_TOTAL_EXCERPT_BYTES) throw new FeedbackError("Combined selected excerpts are too large.");
      lines.push(file ? "Selected file text:" : "Selected assistant text:", "", fence(excerpt), "");
    }
    if (annotation.kind === "comment") {
      lines.push("User comment:", quote(annotation.comment), "");
    } else {
      const action = actionSemantics.get(annotation.actionId);
      if (!action) throw new FeedbackError("Quick action is unsupported.");
      lines.push(`Quick action: ${action.label}`);
      if (action.description) lines.push(quote(action.description));
      lines.push("");
    }
  });

  return lines.join("\n").trimEnd();
}

export type FeedbackWrapper = (feedback: string) => string;

export function plannotatorMessageWrapper(feedback: string): string {
  return getAnnotateMessageFeedbackPrompt("pi", loadConfig(), { feedback });
}

export function plannotatorFileWrapper(filePath: string, fileHeader = "File"): FeedbackWrapper {
  return (feedback) => getAnnotateFileFeedbackPrompt("pi", loadConfig(), {
    feedback,
    filePath,
    fileHeader,
  });
}

export function defaultWrapperFor(snapshot: MessageSnapshot): FeedbackWrapper {
  if (isFileSnapshot(snapshot) && snapshot.filePath) {
    return plannotatorFileWrapper(snapshot.filePath);
  }
  return plannotatorMessageWrapper;
}

export function buildWrappedFeedback(
  snapshot: MessageSnapshot,
  annotations: readonly Annotation[],
  wrapper: FeedbackWrapper = defaultWrapperFor(snapshot),
): string {
  const prompt = wrapper(buildRawFeedback(snapshot, annotations));
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
    throw new FeedbackError(`Rendered feedback is larger than ${MAX_PROMPT_BYTES} bytes.`);
  }
  return prompt;
}

export function getQuickActions(): typeof QUICK_ACTIONS {
  return QUICK_ACTIONS;
}
