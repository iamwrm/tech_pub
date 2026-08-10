import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { sanitizeDisplayText } from "./terminal-safety.ts";

export const BTW2_WIDGET_KEY = "pa-btw2";
export const BTW2_WIDGET_MAX_LINES = 9;

export type Btw2RunStatus = "idle" | "running" | "stopping" | "forking" | "error";

const OPAQUE_OPENAI_COMPACTION_STRATEGY = "openai-responses-compaction-v2";
const OPAQUE_OPENAI_COMPACTION_SHIM = "[OpenAI native compaction checkpoint]";

/**
 * Raw BTW2 agents cannot run the provider-specific replay hook used by the
 * OpenAI server-compaction extension. Refuse rather than silently dropping the
 * conversation that precedes its opaque checkpoint.
 */
export function hasOpaqueProviderCheckpoint(entries: readonly unknown[]): boolean {
  return entries.some((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entry = value as { type?: unknown; summary?: unknown; details?: unknown };
    if (entry.type !== "compaction") return false;
    if (entry.summary === OPAQUE_OPENAI_COMPACTION_SHIM) return true;
    if (typeof entry.details !== "object" || entry.details === null || Array.isArray(entry.details)) {
      return false;
    }
    return (entry.details as { strategy?: unknown }).strategy === OPAQUE_OPENAI_COMPACTION_STRATEGY;
  });
}

export type Btw2Command =
  | { kind: "browse" }
  | { kind: "send"; text: string }
  | { kind: "fork"; name?: string }
  | { kind: "discard" }
  | { kind: "stop" }
  | { kind: "dismiss" }
  | { kind: "help" };

export interface Btw2WidgetState {
  modelLabel: string;
  thinkingLevel: ThinkingLevel;
  status: Btw2RunStatus;
  completedTurns: number;
  lastQuestion?: string;
  answerText?: string;
  errorMessage?: string;
}

export interface Btw2ForkNotice {
  sessionId: string;
  sessionPath: string;
}

export function parseBtw2Command(raw: string): Btw2Command {
  const text = raw.trim();
  if (!text) return { kind: "browse" };
  if (text === "--discard") return { kind: "discard" };
  if (text === "--stop") return { kind: "stop" };
  if (text === "--dismiss") return { kind: "dismiss" };
  if (text === "--help" || text === "-h") return { kind: "help" };
  if (text === "--fork") return { kind: "fork" };
  if (text.startsWith("--fork ")) {
    const name = text.slice("--fork ".length).trim();
    return { kind: "fork", ...(name ? { name } : {}) };
  }
  return { kind: "send", text };
}

export function oneLine(text: string, maxChars = 96): string {
  const compact = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function assistantText(message: AgentMessage | undefined): string {
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function messageText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }
  return assistantText(message);
}

export function serializeBtw2Transcript(messages: readonly AgentMessage[]): string {
  const sections: string[] = ["# BTW2 transcript", ""];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const label = message.role === "user" ? "User" : "Assistant";
    const text = sanitizeDisplayText(messageText(message)).trim();
    if (!text) continue;
    sections.push(`## ${label}`, "", text, "");
  }
  return sections.join("\n").trimEnd();
}

function recentAnswerLines(text: string, maxLines: number): string[] {
  const compactLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => oneLine(line, 100));
  if (compactLines.length === 0) return [];
  return compactLines.slice(-maxLines);
}

export function buildBtw2WidgetLines(state: Btw2WidgetState): string[] {
  const status =
    state.status === "running"
      ? "answering"
      : state.status === "stopping"
        ? "stopping"
        : state.status === "forking"
          ? "forking"
          : state.status === "error"
            ? "error"
            : "ready";
  const lines = [
    `BTW2 · ${state.modelLabel} · thinking ${state.thinkingLevel} · no tools`,
    `${status} · ${state.completedTurns} completed turn${state.completedTurns === 1 ? "" : "s"}`,
  ];
  if (state.lastQuestion) lines.push(`Q  ${oneLine(state.lastQuestion, 100)}`);
  const answerLines = recentAnswerLines(state.answerText ?? "", 3);
  for (const line of answerLines) lines.push(`A  ${line}`);
  if (state.errorMessage) lines.push(`!  ${oneLine(state.errorMessage, 100)}`);
  lines.push("/btw2 <follow-up> · /btw2 actions · /btw2 --fork [name]");
  return lines.slice(0, BTW2_WIDGET_MAX_LINES);
}

export function buildForkNoticeLines(result: Btw2ForkNotice): string[] {
  return [
    `BTW2 fork ready · ${sanitizeDisplayText(result.sessionId)}`,
    `Resume: prime-agent -r ${sanitizeDisplayText(result.sessionId)}`,
    `Path: ${sanitizeDisplayText(result.sessionPath)}`,
    "Parent stays active; concurrent writes to the same workspace can conflict.",
    "/btw2 --dismiss to clear this notice",
  ];
}

export function defaultForkName(messages: readonly AgentMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const text = firstUser ? messageText(firstUser) : "side conversation";
  return `BTW2: ${oneLine(text || "side conversation", 48)}`;
}

export function validatePromotableMessages(messages: readonly AgentMessage[]): void {
  if (messages.length === 0) throw new Error("BTW2 has no completed turns to fork");
  if (messages.length % 2 !== 0) throw new Error("BTW2 transcript is incomplete");
  for (let index = 0; index < messages.length; index += 2) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user?.role !== "user" || assistant?.role !== "assistant") {
      throw new Error("BTW2 transcript must alternate user and assistant messages");
    }
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error("BTW2 transcript contains an incomplete assistant response");
    }
    if (assistant.content.some((part) => part.type === "toolCall")) {
      throw new Error("BTW2 no-tool transcript unexpectedly contains a tool call");
    }
  }
}
