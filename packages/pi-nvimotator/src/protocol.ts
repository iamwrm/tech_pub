export const PROTOCOL_VERSION = 2 as const;
export const MAX_UNIX_SOCKET_PATH_BYTES = 100;
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_ANNOTATIONS = 200;
export const MAX_COMMENT_BYTES = 16 * 1024;
export const MAX_SELECTED_LINES = 1000;
export const MAX_EXCERPT_BYTES = 64 * 1024;
export const MAX_TOTAL_EXCERPT_BYTES = 256 * 1024;
export const MAX_PROMPT_BYTES = 512 * 1024;
export const MAX_ID_BYTES = 128;
export const MAX_BRIDGE_ID = 999_999;
export const CONNECTION_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_CONNECTIONS = 16;

// Plannotator toolbar actions followed by the exact DEFAULT_QUICK_LABELS from
// packages/ui/utils/quickLabels.ts. Keep IDs, labels, ordering, and tips aligned.
export const QUICK_ACTIONS = Object.freeze([
  { id: "deletion", label: "Deletion", description: "I don't want this in the message." },
  { id: "thumbs-up", label: "👍 Looks good", description: "" },
  { id: "clarify-this", label: "❓ Clarify this", description: "" },
  { id: "missing-overview", label: "🗺️ Missing overview", description: "Provide a narrative overview of what is being built, why it is being built, and how it will be built. Add this before the implementation details." },
  { id: "verify-this", label: "🔍 Verify this", description: "This seems like an assumption. Verify by reading the actual code before proceeding." },
  { id: "give-me-an-example", label: "🔬 Give me an example", description: "This is too abstract. Show a before/after, a sample input/output, or a specific scenario so I can see how this actually works." },
  { id: "match-existing-patterns", label: "🧬 Match existing patterns", description: "Search the codebase for existing patterns, components, or utilities that already solve this. Reuse what exists rather than introducing a new approach." },
  { id: "consider-alternatives", label: "🔄 Consider alternatives", description: "Propose 2-3 alternative approaches with trade-offs based on the actual codebase. Also check the Plannotator plans directory (PLANNOTATOR_DATA_DIR or ~/.plannotator/plans/) for prior plan versions that may have already explored or rejected similar approaches." },
  { id: "ensure-no-regression", label: "📉 Ensure no regression", description: "Verify that this change will not break existing behavior. Identify what could regress and how to protect against it." },
  { id: "out-of-scope", label: "🚫 Out of scope", description: "This is not part of the current task. Remove it and stay focused on what was actually requested." },
  { id: "needs-tests", label: "🧪 Needs tests", description: "" },
  { id: "nice-approach", label: "👍 Nice approach", description: "" },
] as const);

export type QuickActionId = (typeof QUICK_ACTIONS)[number]["id"];
const QUICK_ACTION_IDS: ReadonlySet<string> = new Set(QUICK_ACTIONS.map((action) => action.id));

export interface BridgeManifest {
  protocolVersion: typeof PROTOCOL_VERSION;
  bridgeId: number;
  instanceId: string;
  sessionId: string;
  snapshotId: string;
  entryId: string;
  messageHash: string;
  pid: number;
  transport: "unix";
  socketPath: string;
  token: string;
  startedAt: string;
}

export interface TextAnchor {
  selection: "line" | "character";
  startLine: number;
  startByte: number;
  endLine: number;
  endByte: number;
}

export interface CommentAnnotation {
  id: string;
  kind: "comment";
  anchor?: TextAnchor;
  comment: string;
}

export interface QuickActionAnnotation {
  id: string;
  kind: "quickAction";
  anchor: TextAnchor;
  actionId: QuickActionId;
}

export type Annotation = CommentAnnotation | QuickActionAnnotation;

type RequestBase = {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  token: string;
  bridgeId: number;
  instanceId: string;
  sessionId: string;
  snapshotId: string;
};

export type PingRequest = RequestBase & { type: "ping" };
export type SnapshotRequest = RequestBase & { type: "snapshot" };
export type RenderRequest = RequestBase & {
  type: "render";
  submissionId: string;
  annotations: Annotation[];
};
export type SubmitRequest = RequestBase & {
  type: "submit";
  submissionId: string;
  annotations: Annotation[];
};
export type FinishRequest = RequestBase & { type: "finish"; submissionId: string };
export type BridgeRequest = PingRequest | SnapshotRequest | RenderRequest | SubmitRequest | FinishRequest;

export type ErrorCode =
  | "invalid_json"
  | "invalid_utf8"
  | "incompatible_version"
  | "invalid_request"
  | "authentication_failed"
  | "stale_session"
  | "stale_snapshot"
  | "busy"
  | "bridge_stopping"
  | "internal_error";

export interface ErrorResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: false;
  requestId?: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type SuccessResponse =
  | { protocolVersion: typeof PROTOCOL_VERSION; ok: true; requestId: string; type: "pong"; bridgeId: number; instanceId: string; sessionId: string; snapshotId: string }
  | { protocolVersion: typeof PROTOCOL_VERSION; ok: true; requestId: string; type: "snapshot"; bridgeId: number; instanceId: string; sessionId: string; snapshotId: string; entryId: string; messageHash: string; text: string; quickActions: typeof QUICK_ACTIONS }
  | { protocolVersion: typeof PROTOCOL_VERSION; ok: true; requestId: string; type: "rendered"; bridgeId: number; instanceId: string; sessionId: string; snapshotId: string; submissionId: string; annotationCount: number; prompt: string }
  | { protocolVersion: typeof PROTOCOL_VERSION; ok: true; requestId: string; type: "submitted"; bridgeId: number; instanceId: string; sessionId: string; snapshotId: string; submissionId: string; annotationCount: number; status: "scheduled" }
  | { protocolVersion: typeof PROTOCOL_VERSION; ok: true; requestId: string; type: "finished"; bridgeId: number; instanceId: string; sessionId: string; snapshotId: string; submissionId: string };

export type BridgeResponse = SuccessResponse | ErrorResponse;
export type ParseResult = { ok: true; request: BridgeRequest } | { ok: false; response: ErrorResponse };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maxBytes = MAX_ID_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes;
}

function identifier(value: unknown): value is string {
  return boundedString(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function canonicalBridgeId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_BRIDGE_ID;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10_000_000;
}

function parseAnchor(value: unknown): value is TextAnchor {
  if (!record(value) || !onlyKeys(value, ["selection", "startLine", "startByte", "endLine", "endByte"])) return false;
  if (value.selection !== "line" && value.selection !== "character") return false;
  if (!positiveInteger(value.startLine) || !positiveInteger(value.endLine) || value.endLine < value.startLine) return false;
  if (!nonNegativeInteger(value.startByte) || !nonNegativeInteger(value.endByte)) return false;
  return value.endLine - value.startLine + 1 <= MAX_SELECTED_LINES;
}

function parseAnnotation(value: unknown): value is Annotation {
  if (!record(value) || !identifier(value.id)) return false;
  if (value.kind === "comment") {
    if (!onlyKeys(value, ["id", "kind", "anchor", "comment"])) return false;
    if (!boundedString(value.comment, MAX_COMMENT_BYTES) || !(value.comment as string).trim()) return false;
    return value.anchor === undefined || parseAnchor(value.anchor);
  }
  if (value.kind === "quickAction") {
    if (!onlyKeys(value, ["id", "kind", "anchor", "actionId"])) return false;
    if (!parseAnchor(value.anchor)) return false;
    return typeof value.actionId === "string" && QUICK_ACTION_IDS.has(value.actionId);
  }
  return false;
}

const BASE_KEYS = ["protocolVersion", "requestId", "type", "token", "bridgeId", "instanceId", "sessionId", "snapshotId"] as const;

export function errorResponse(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  requestId?: string,
): ErrorResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ok: false,
    ...(requestId ? { requestId: requestId.slice(0, MAX_ID_BYTES) } : {}),
    code,
    message: message.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 512),
    retryable,
  };
}

export function parseRequest(value: unknown): ParseResult {
  const requestId = record(value) && typeof value.requestId === "string" ? value.requestId : undefined;
  if (!record(value)) return { ok: false, response: errorResponse("invalid_request", "Request must be a JSON object", false, requestId) };
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, response: errorResponse("incompatible_version", `Protocol version ${String(value.protocolVersion)} is unsupported`, false, requestId) };
  }
  if (!identifier(value.requestId) || !boundedString(value.token, 256) || !canonicalBridgeId(value.bridgeId)) {
    return { ok: false, response: errorResponse("invalid_request", "Request identity is invalid", false, requestId) };
  }
  if (!identifier(value.instanceId) || !boundedString(value.sessionId, 256) || !identifier(value.snapshotId)) {
    return { ok: false, response: errorResponse("invalid_request", "Session or snapshot identity is invalid", false, value.requestId) };
  }
  if (value.type === "ping" || value.type === "snapshot") {
    if (!onlyKeys(value, BASE_KEYS)) return { ok: false, response: errorResponse("invalid_request", "Request has unknown fields", false, value.requestId) };
    return { ok: true, request: value as unknown as PingRequest | SnapshotRequest };
  }
  if (value.type === "finish") {
    if (!onlyKeys(value, [...BASE_KEYS, "submissionId"]) || !identifier(value.submissionId)) {
      return { ok: false, response: errorResponse("invalid_request", "Finish request is invalid", false, value.requestId) };
    }
    return { ok: true, request: value as unknown as FinishRequest };
  }
  if (value.type === "render" || value.type === "submit") {
    if (!onlyKeys(value, [...BASE_KEYS, "submissionId", "annotations"]) || !identifier(value.submissionId)) {
      return { ok: false, response: errorResponse("invalid_request", "Submission identity is invalid", false, value.requestId) };
    }
    if (!Array.isArray(value.annotations) || value.annotations.length === 0 || value.annotations.length > MAX_ANNOTATIONS) {
      return { ok: false, response: errorResponse("invalid_request", "Annotation count is invalid", false, value.requestId) };
    }
    if (!value.annotations.every(parseAnnotation)) {
      return { ok: false, response: errorResponse("invalid_request", "One or more annotations are invalid", false, value.requestId) };
    }
    const ids = new Set(value.annotations.map((annotation) => (annotation as Annotation).id));
    if (ids.size !== value.annotations.length) {
      return { ok: false, response: errorResponse("invalid_request", "Annotation IDs must be unique", false, value.requestId) };
    }
    return { ok: true, request: value as unknown as RenderRequest | SubmitRequest };
  }
  return { ok: false, response: errorResponse("invalid_request", "Request type is invalid", false, value.requestId as string) };
}
