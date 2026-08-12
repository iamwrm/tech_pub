import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText } from "./terminal-safety.ts";

export const BTW2_WIDGET_KEY = "pi-btw";
export const BTW2_WIDGET_MAX_LINES = 9;

export type Btw2RunStatus = "idle" | "running" | "stopping" | "forking" | "error";

const OPAQUE_OPENAI_COMPACTION_STRATEGY = "openai-responses-compaction-v2";
const OPAQUE_OPENAI_COMPACTION_SHIM = "[OpenAI native compaction checkpoint]";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const STANDARD_RESPONSES_BASE_URL = "https://fluxionai.space/v1";
const STANDARD_RESPONSES_MODELS = new Map<string, ReadonlySet<string>>([
  ["fluxion-gpt", new Set(["gpt-5.5", "gpt-5.6-sol"])],
  ["fluxion-grok", new Set(["grok-4.5"])],
]);
const MAX_REPLACEMENT_HISTORY_BYTES = 8 * 1024 * 1024;
const CODEX_ARTIFACT_KEYS = new Set([
  "type",
  "id",
  "encrypted_content",
  "internal_chat_message_metadata_passthrough",
]);
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);

type JsonRecord = Record<string, unknown>;

export interface OpaqueProviderReplay {
  messages: AgentMessage[];
  rewritePayload(payload: unknown, requestModel: Model<any>): unknown;
}

interface OpaqueReplayDetails {
  adapter: "codex-trigger-sse" | "standard-responses-json";
  provider: string;
  api: string;
  model: string;
  baseUrl: string;
  replacementHistory: unknown[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.search || url.hash || url.username || url.password) {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function hasOnlyKeys(value: JsonRecord, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}

function validCodexUserItem(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "message" || value.role !== "user" || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.length > 0 && value.content.every((part) => {
    if (!isRecord(part)) return false;
    if (part.type === "input_text") {
      return typeof part.text === "string" && hasOnlyKeys(part, new Set(["type", "text"]));
    }
    return part.type === "input_image" &&
      typeof part.image_url === "string" &&
      (part.detail === undefined || (typeof part.detail === "string" && IMAGE_DETAILS.has(part.detail))) &&
      hasOnlyKeys(part, new Set(["type", "image_url", "detail"]));
  });
}

function validReplacementHistory(
  adapter: OpaqueReplayDetails["adapter"],
  value: unknown[],
): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPLACEMENT_HISTORY_BYTES) return false;
  const artifacts = value.filter(
    (item): item is JsonRecord =>
      isRecord(item) && (item.type === "compaction" || item.type === "compaction_summary"),
  );
  if (artifacts.length !== 1 || value.at(-1) !== artifacts[0]) return false;
  const artifact = artifacts[0];
  if (typeof artifact.encrypted_content !== "string" || !artifact.encrypted_content.trim()) return false;
  if (adapter === "standard-responses-json") return true;
  if (
    artifact.type !== "compaction" ||
    !hasOnlyKeys(artifact, CODEX_ARTIFACT_KEYS) ||
    (artifact.id !== undefined && !isSafeIdentifier(artifact.id))
  ) {
    return false;
  }
  const metadata = artifact.internal_chat_message_metadata_passthrough;
  if (
    metadata !== undefined &&
    (!isRecord(metadata) ||
      !hasOnlyKeys(metadata, new Set(["turn_id"])) ||
      (metadata.turn_id !== undefined && !isSafeIdentifier(metadata.turn_id)))
  ) {
    return false;
  }
  return value.slice(0, -1).every(validCodexUserItem);
}

function parseOpaqueReplayDetails(value: unknown): OpaqueReplayDetails | undefined {
  if (!isRecord(value) || value.strategy !== OPAQUE_OPENAI_COMPACTION_STRATEGY) return undefined;
  if (value.adapter !== "codex-trigger-sse" && value.adapter !== "standard-responses-json") {
    return undefined;
  }
  if (
    typeof value.provider !== "string" ||
    typeof value.api !== "string" ||
    typeof value.model !== "string" ||
    typeof value.baseUrl !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.replacementHistory) ||
    value.replacementHistory.length === 0 ||
    !value.replacementHistory.every(isRecord) ||
    !validReplacementHistory(value.adapter, value.replacementHistory)
  ) {
    return undefined;
  }
  return {
    adapter: value.adapter,
    provider: value.provider,
    api: value.api,
    model: value.model,
    baseUrl: value.baseUrl,
    replacementHistory: structuredClone(value.replacementHistory),
  };
}

function assertReplayIdentity(details: OpaqueReplayDetails, model: Model<any>): void {
  const modelBaseUrl = canonicalBaseUrl(
    model.baseUrl ?? (model.provider === "openai-codex" ? DEFAULT_CODEX_BASE_URL : undefined),
  );
  const detailsBaseUrl = canonicalBaseUrl(details.baseUrl);
  const codexIdentity =
    details.adapter === "codex-trigger-sse" &&
    model.provider === "openai-codex" &&
    model.api === "openai-codex-responses" &&
    modelBaseUrl === DEFAULT_CODEX_BASE_URL;
  const standardIdentity =
    details.adapter === "standard-responses-json" &&
    model.api === "openai-responses" &&
    STANDARD_RESPONSES_MODELS.get(model.provider)?.has(model.id) === true &&
    details.model === model.id &&
    modelBaseUrl === STANDARD_RESPONSES_BASE_URL;
  if (
    details.provider !== model.provider ||
    details.api !== model.api ||
    !modelBaseUrl ||
    detailsBaseUrl !== modelBaseUrl ||
    (!codexIdentity && !standardIdentity)
  ) {
    throw new Error(
      "BTW2 cannot replay the opaque OpenAI checkpoint with the selected provider endpoint or model",
    );
  }
}

/** Whether a branch contains a native checkpoint marker, including malformed ones. */
export function hasOpaqueProviderCheckpoint(entries: readonly unknown[]): boolean {
  return entries.some((value) => {
    if (!isRecord(value) || value.type !== "compaction") return false;
    return value.summary === OPAQUE_OPENAI_COMPACTION_SHIM ||
      (isRecord(value.details) && value.details.strategy === OPAQUE_OPENAI_COMPACTION_STRATEGY);
  });
}

/**
 * Collect the messages that follow the given checkpoint entry on the leaf
 * path. The retained window (firstKeptEntryId .. checkpoint) is owned by the
 * checkpoint's replacement history and therefore excluded.
 */
function messagesAfterCheckpoint(
  branch: readonly SessionEntry[],
  leafId: string | null | undefined,
  checkpoint: Extract<SessionEntry, { type: "compaction" }>,
): AgentMessage[] {
  const byId = new Map(branch.map((entry) => [entry.id, entry]));
  let current: SessionEntry | undefined = leafId ? byId.get(leafId) : branch[branch.length - 1];
  if (!current) {
    throw new Error("BTW2 could not locate the opaque checkpoint boundary in the built context");
  }
  const tail: SessionEntry[] = [];
  while (current && current.id !== checkpoint.id) {
    tail.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (!current) {
    throw new Error("BTW2 could not locate the opaque checkpoint boundary in the built context");
  }
  // The retained window between firstKeptEntryId and the checkpoint is owned
  // by the checkpoint's replacement history. Pi writes checkpoints whose
  // firstKeptEntryId lies on the same path; anything else is malformed.
  let retained = current.parentId ? byId.get(current.parentId) : undefined;
  while (retained) {
    if (retained.id === checkpoint.firstKeptEntryId) {
      return tail.reverse().flatMap(sessionEntryToContextMessages);
    }
    retained = retained.parentId ? byId.get(retained.parentId) : undefined;
  }
  throw new Error("BTW2 opaque checkpoint retained-message boundary is invalid");
}

/**
 * Build the raw-Agent replay plan for the latest native checkpoint on the
 * branch.
 *
 * Pi's normal context contains a shim summary followed by retained messages.
 * The provider-native replacement history already owns both pieces, so BTW2
 * removes them from its Agent transcript and prepends the persisted
 * replacement history to each exact provider payload. Post-checkpoint messages
 * (including completed BTW2 turns) remain provider-serialized by pi-ai.
 *
 * Pi's compaction summary message carries no retained-message count, so the
 * boundary is derived from the persisted branch: every entry after the
 * checkpoint entry on the leaf path is the post-checkpoint tail.
 */
export function prepareOpaqueProviderReplay(
  branch: readonly SessionEntry[],
  leafId: string | null | undefined,
  model: Model<any>,
): OpaqueProviderReplay | undefined {
  const checkpoint = getLatestCompactionEntry([...branch]);
  if (!checkpoint) return undefined;
  const marked =
    checkpoint.summary === OPAQUE_OPENAI_COMPACTION_SHIM ||
    (isRecord(checkpoint.details) && checkpoint.details.strategy === OPAQUE_OPENAI_COMPACTION_STRATEGY);
  if (!marked) return undefined;

  const details = parseOpaqueReplayDetails(checkpoint.details);
  if (!details || checkpoint.summary !== OPAQUE_OPENAI_COMPACTION_SHIM) {
    throw new Error("BTW2 cannot replay the malformed opaque OpenAI server-compaction checkpoint");
  }
  assertReplayIdentity(details, model);

  return {
    messages: structuredClone(messagesAfterCheckpoint(branch, leafId, checkpoint)),
    rewritePayload(payload, requestModel) {
      assertReplayIdentity(details, requestModel);
      if (!isRecord(payload) || !Array.isArray(payload.input)) {
        throw new Error("BTW2 opaque checkpoint replay requires a Responses provider payload");
      }
      let tailStart = 0;
      while (
        tailStart < payload.input.length &&
        isRecord(payload.input[tailStart]) &&
        (payload.input[tailStart].role === "system" || payload.input[tailStart].role === "developer")
      ) {
        tailStart++;
      }
      const rewritten: JsonRecord = {
        ...payload,
        input: [
          ...structuredClone(details.replacementHistory),
          ...structuredClone(payload.input.slice(tailStart)),
        ],
      };
      delete rewritten.messages;
      delete rewritten.previous_response_id;
      return rewritten;
    },
  };
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
  /** Whether the side branch runs with the core tool set enabled (/tools). */
  toolsEnabled?: boolean;
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
  const toolMode = state.toolsEnabled ? "with tools" : "no tools";
  const lines = [
    `BTW2 · ${state.modelLabel} · thinking ${state.thinkingLevel} · ${toolMode}`,
    `${status} · ${state.completedTurns} completed turn${state.completedTurns === 1 ? "" : "s"}`,
  ];
  if (state.lastQuestion) lines.push(`Q  ${oneLine(state.lastQuestion, 100)}`);
  const answerLines = recentAnswerLines(state.answerText ?? "", 3);
  for (const line of answerLines) lines.push(`A  ${line}`);
  if (state.errorMessage) lines.push(`!  ${oneLine(state.errorMessage, 100)}`);
  lines.push("/btw2 <follow-up> · /btw2 actions · /btw2 --fork · /tools");
  return lines.slice(0, BTW2_WIDGET_MAX_LINES);
}

export function buildForkNoticeLines(result: Btw2ForkNotice): string[] {
  return [
    `BTW2 fork ready · ${sanitizeDisplayText(result.sessionId)}`,
    `Resume: pi --session ${sanitizeDisplayText(result.sessionId)}`,
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

/**
 * Validate a transcript of completed turns for materialization.
 *
 * Without tools, each turn is exactly one user/assistant pair. With tools
 * enabled, a turn may contain intermediate assistant (tool-call) and
 * toolResult messages, but must still start with a user message and end with
 * a final assistant text response that carries no pending tool calls.
 */
export function validatePromotableMessages(messages: readonly AgentMessage[], toolsEnabled = false): void {
  if (messages.length === 0) throw new Error("BTW2 has no completed turns to fork");
  if (messages.length < 2) throw new Error("BTW2 transcript is incomplete");
  if (!toolsEnabled && messages.length % 2 !== 0) {
    // No-tool turns are exactly one user/assistant pair; a dangling user or
    // assistant means the transcript was cut off mid-turn.
    throw new Error("BTW2 transcript is incomplete");
  }
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first.role !== "user") {
    throw new Error("BTW2 transcript must alternate user and assistant messages");
  }
  if (last.role !== "assistant") {
    throw new Error("BTW2 transcript must alternate user and assistant messages");
  }
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    throw new Error("BTW2 transcript contains an incomplete assistant response");
  }
  if (last.content.some((part) => part.type === "toolCall")) {
    throw new Error(toolsEnabled
      ? "BTW2 transcript ends with an unresolved tool call"
      : "BTW2 no-tool transcript unexpectedly contains a tool call");
  }
  if (last.content.some((part) => part.type === "toolCall")) {
    throw new Error(toolsEnabled
      ? "BTW2 transcript ends with an unresolved tool call"
      : "BTW2 no-tool transcript unexpectedly contains a tool call");
  }
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      // A new turn may only start after the previous turn's final assistant
      // response (which never carries pending tool calls).
      const previous = messages[index - 1];
      if (previous.role !== "assistant") {
        throw new Error("BTW2 transcript must alternate user and assistant messages");
      }
      continue;
    }
    if (message.role === "toolResult") {
      const previous = messages[index - 1];
      if (!toolsEnabled || previous.role !== "assistant" ||
        !previous.content.some((part) => part.type === "toolCall")) {
        throw new Error("BTW2 transcript contains an unexpected tool result");
      }
      continue;
    }
    if (message.role === "assistant") {
      if (message.content.some((part) => part.type === "toolCall")) {
        const next = messages[index + 1];
        if (!next || next.role !== "toolResult") {
          throw new Error("BTW2 transcript contains an unresolved tool call");
        }
      }
      continue;
    }
    throw new Error(`Unsupported BTW2 message role: ${String((message as { role?: unknown }).role)}`);
  }
}
