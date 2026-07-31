import { AsyncLocalStorage } from "node:async_hooks";
import { arch, platform, release } from "node:os";
import {
	convertToLlm,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	type Api,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type Usage,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { Box, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

export const SERVER_COMPACTION_ENV = "PI_OPENAI_SERVER_COMPACTION";
export const SERVER_COMPACTION_STRATEGY = "openai-responses-compaction-v2";
export const SERVER_COMPACTION_SHIM_SUMMARY = "[OpenAI native compaction checkpoint]";
export const SERVER_COMPACTION_DISPLAY_ENTRY_TYPE = "ren-public-package.openai-native-compaction";
export const SERVER_COMPACTION_DISPLAY_TEXT = [
	"Native Responses compaction was used for this checkpoint.",
	"",
	"The provider's opaque compaction result is not human-readable in Pi.",
	"",
	"Warning: do not turn Responses compaction off or switch providers mid-session; old context may be much less reliable.",
].join("\n");
export const RETAINED_USER_TOKEN_BUDGET = 64_000;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_REPLACEMENT_HISTORY_BYTES = 8 * 1024 * 1024;
export const REMOTE_REQUEST_TIMEOUT_MS = 300_000;
export const REMOTE_COMPACTION_MAX_ATTEMPTS = 3;
export const REMOTE_COMPACTION_RETRY_BASE_DELAY_MS = 500;
export const REMOTE_COMPACTION_OVERLOAD_RETRY_BASE_DELAY_MS = 30_000;

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const FLUXION_RESPONSES_BASE_URL = "https://fluxionai.space/v1";
const STANDARD_RESPONSES_MODELS = new Map<string, ReadonlySet<string>>([
	["fluxion-gpt", new Set(["gpt-5.5", "gpt-5.6-sol"])],
	["fluxion-grok", new Set(["grok-4.5"])],
]);
const REMOTE_FEATURE = "remote_compaction_v2";
const PAYLOAD_CAPTURE_BASE_URL = "http://127.0.0.1:1";
const PAYLOAD_CAPTURE_TOKEN = [
	Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
	Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "capture-only" } })).toString("base64url"),
	"signature",
].join(".");
const MAX_DIAGNOSTIC_CHARS = 320;
const PROMPT_CACHE_KEY_MAX_CHARS = 64;

const CONTEXT_ENVELOPES: ReadonlyArray<readonly [string, string]> = [
	["# AGENTS.md instructions", "</INSTRUCTIONS>"],
	["<environment_context>", "</environment_context>"],
	["<skill>", "</skill>"],
	["<user_shell_command>", "</user_shell_command>"],
	["<turn_aborted>", "</turn_aborted>"],
	["<subagent_notification>", "</subagent_notification>"],
	["<recommended_plugins>", "</recommended_plugins>"],
];

const WIRE_ARTIFACT_TYPES = new Set(["compaction", "compaction_summary"]);
const PERSISTED_ARTIFACT_KEYS = new Set([
	"type",
	"id",
	"encrypted_content",
	"internal_chat_message_metadata_passthrough",
]);
const PERSISTED_METADATA_KEYS = new Set(["turn_id"]);
const PERSISTED_USER_ITEM_KEYS = new Set(["type", "role", "content"]);
const PERSISTED_USER_TEXT_KEYS = new Set(["type", "text"]);
const PERSISTED_USER_IMAGE_KEYS = new Set(["type", "image_url", "detail"]);
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);
const RETRYABLE_PROVIDER_CODES = new Set(["server_is_overloaded", "slow_down"]);

type JsonObject = Record<string, unknown>;
type ResponseItem = JsonObject & {
	type?: string;
	role?: string;
	content?: unknown;
	encrypted_content?: string;
};
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type CompactionAdapterKind = "codex-trigger-sse" | "standard-responses-json";

type CanonicalCompactionBackend = {
	adapter: CompactionAdapterKind;
	baseUrl: string;
	compactionUrl: string;
};

type NativeIdentity = {
	adapter: CompactionAdapterKind;
	provider: string;
	api: string;
	model: string;
	baseUrl: string;
};

export type ServerCompactionDetails = NativeIdentity & {
	strategy: typeof SERVER_COMPACTION_STRATEGY;
	replacementHistory: ResponseItem[];
	createdAt: string;
	responseId?: string;
	usage?: Usage;
};

type ServerCompactionDisplayData = {
	usage?: Usage;
};

type RemoteCompactionResult = {
	replacementHistory: ResponseItem[];
	responseId?: string;
	usage?: Usage;
};

type ProviderStreams = ReturnType<typeof openAICodexResponsesApi>;

export type PreparedPayloadSnapshot = {
	sessionId: string;
	leafId: string | null;
	identity: NativeIdentity;
	payload: JsonObject;
};

type TaggedPreparedPayloadSnapshot = PreparedPayloadSnapshot & {
	generation: number;
	invocationSequence: number;
};

type RequestMode = "normal" | "summarization";

type RequestPlanBase = {
	sessionId: string;
	leafId: string | null;
	identity: NativeIdentity;
	mode: RequestMode;
	generation: number;
	invocationSequence: number;
};

type RequestPlan =
	| (RequestPlanBase & {
		kind: "send";
		replayHistory?: ResponseItem[];
		originalSummarizerInput?: ResponseItem[];
	})
	| (RequestPlanBase & { kind: "block"; error: string });

type RequestPlanDraft =
	| (Omit<RequestPlanBase, "generation" | "invocationSequence"> & {
		kind: "send";
		replayHistory?: ResponseItem[];
		originalSummarizerInput?: ResponseItem[];
	})
	| (Omit<RequestPlanBase, "generation" | "invocationSequence"> & { kind: "block"; error: string });

type RequestScope = {
	generation: number;
	invocationSequence: number;
	consumed: boolean;
	plan?: RequestPlan;
};

type LatestCheckpoint =
	| { kind: "none" }
	| { kind: "plain"; entry: Extract<SessionEntry, { type: "compaction" }>; index: number }
	| {
		kind: "native";
		entry: Extract<SessionEntry, { type: "compaction" }>;
		index: number;
		details: ServerCompactionDetails;
	}
	| { kind: "malformed"; entry: Extract<SessionEntry, { type: "compaction" }>; index: number };

type Dependencies = {
	fetchFn?: FetchLike;
	sleepFn?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

class RemoteCompactionError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
		readonly overload = false,
	) {
		super(message);
		this.name = "RemoteCompactionError";
	}
}

class RemoteResponseSizeError extends Error {
	constructor() {
		super("OpenAI server compaction response exceeded the size limit");
		this.name = "RemoteResponseSizeError";
	}
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUsage(value: unknown): value is Usage {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const tokens = [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens];
	const costs = [value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total];
	if (!tokens.every(isTokenCount)) return false;
	if (!costs.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return false;
	return (value.totalTokens as number) >= (value.input as number)
		+ (value.output as number)
		+ (value.cacheRead as number)
		+ (value.cacheWrite as number);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function hasOnlyKeys(value: JsonObject, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function resolveExactHttpsBaseUrl(baseUrl: unknown, expected: string): string | undefined {
	if (typeof baseUrl !== "string" || (baseUrl !== expected && baseUrl !== `${expected}/`)) return undefined;
	try {
		const actual = new URL(baseUrl);
		const canonical = new URL(expected);
		if (
			actual.protocol !== "https:"
			|| actual.hostname !== canonical.hostname
			|| actual.port !== ""
			|| actual.username !== ""
			|| actual.password !== ""
			|| (actual.pathname !== canonical.pathname && actual.pathname !== `${canonical.pathname}/`)
			|| actual.search !== ""
			|| actual.hash !== ""
		) return undefined;
		return expected;
	} catch {
		return undefined;
	}
}

function resolveCodexBackend(baseUrl: unknown): CanonicalCompactionBackend | undefined {
	const raw = baseUrl === undefined ? DEFAULT_CODEX_BASE_URL : baseUrl;
	const canonical = resolveExactHttpsBaseUrl(raw, DEFAULT_CODEX_BASE_URL);
	return canonical
		? {
			adapter: "codex-trigger-sse",
			baseUrl: canonical,
			compactionUrl: `${canonical}/codex/responses`,
		}
		: undefined;
}

function isCodexApiModel(model: unknown): model is Model<any> {
	return isRecord(model)
		&& model.provider === "openai-codex"
		&& model.api === "openai-codex-responses"
		&& typeof model.id === "string";
}

function isStandardResponsesApiModel(model: unknown): model is Model<any> {
	return isRecord(model)
		&& model.api === "openai-responses"
		&& typeof model.provider === "string"
		&& typeof model.id === "string";
}

function resolveStandardResponsesBackend(model: unknown): CanonicalCompactionBackend | undefined {
	if (!isStandardResponsesApiModel(model)) return undefined;
	if (!STANDARD_RESPONSES_MODELS.get(model.provider)?.has(model.id)) return undefined;
	const canonical = resolveExactHttpsBaseUrl(model.baseUrl, FLUXION_RESPONSES_BASE_URL);
	return canonical
		? {
			adapter: "standard-responses-json",
			baseUrl: canonical,
			compactionUrl: `${canonical}/responses/compact`,
		}
		: undefined;
}

function resolveCompactionBackend(model: unknown): CanonicalCompactionBackend | undefined {
	if (isCodexApiModel(model)) return resolveCodexBackend(model.baseUrl);
	return resolveStandardResponsesBackend(model);
}

function isDecoratedApiModel(model: unknown): model is Model<any> {
	return isCodexApiModel(model)
		|| (isStandardResponsesApiModel(model) && STANDARD_RESPONSES_MODELS.has(model.provider));
}

export function featureEnabled(value: string | undefined): boolean {
	if (typeof value !== "string") return true;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function isSupportedCodexModel(model: unknown): model is Model<any> {
	return isCodexApiModel(model) && resolveCodexBackend(model.baseUrl) !== undefined;
}

export function isSupportedStandardResponsesModel(model: unknown): model is Model<any> {
	return resolveStandardResponsesBackend(model) !== undefined;
}

export function isSupportedServerCompactionModel(model: unknown): model is Model<any> {
	return resolveCompactionBackend(model) !== undefined;
}

function identityFor(model: Model<any>): NativeIdentity {
	const backend = resolveCompactionBackend(model);
	if (!backend) throw new Error("the active model does not use a supported Responses compaction endpoint");
	return {
		adapter: backend.adapter,
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: backend.baseUrl,
	};
}

function identitiesMatch(left: NativeIdentity, right: NativeIdentity): boolean {
	return left.adapter === right.adapter
		&& left.provider === right.provider
		&& left.api === right.api
		&& left.model === right.model
		&& left.baseUrl === right.baseUrl;
}

function replayIdentitiesMatch(left: NativeIdentity, right: NativeIdentity): boolean {
	return left.adapter === right.adapter
		&& left.provider === right.provider
		&& left.api === right.api
		&& left.baseUrl === right.baseUrl
		&& (left.adapter === "codex-trigger-sse" || left.model === right.model);
}

export function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("invalid token");
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
		if (!isRecord(payload)) throw new Error("invalid payload");
		const auth = payload["https://api.openai.com/auth"];
		if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) {
			throw new Error("missing account id");
		}
		return auth.chatgpt_account_id;
	} catch {
		throw new Error("OpenAI Codex authentication did not contain an account id");
	}
}

function mergeFeatureHeader(current: string | null): string {
	const features = (current ?? "")
		.split(",")
		.map((feature) => feature.trim())
		.filter(Boolean);
	return [...new Set([...features, REMOTE_FEATURE])].join(",");
}

function withRemoteFeatureProviderHeaders(
	modelHeaders: Model<Api>["headers"],
	headers: SimpleStreamOptions["headers"],
): Record<string, string | null> {
	const merged = new Headers();
	for (const source of [modelHeaders, headers]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value === null) merged.delete(name);
			else merged.set(name, value);
		}
	}
	const result: Record<string, string | null> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() !== "x-codex-beta-features") result[name] = value;
	}
	result["x-codex-beta-features"] = mergeFeatureHeader(merged.get("x-codex-beta-features"));
	return result;
}

export function buildCodexCompactionHeaders(params: {
	apiKey: string;
	modelHeaders?: Model<Api>["headers"];
	headers?: Record<string, string>;
	sessionId: string;
}): Record<string, string> {
	const headers = new Headers();
	for (const source of [params.modelHeaders, params.headers]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value !== null) headers.set(name, value);
		}
	}
	const requestId = Array.from(params.sessionId).slice(0, PROMPT_CACHE_KEY_MAX_CHARS).join("");
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("chatgpt-account-id", extractCodexAccountId(params.apiKey));
	headers.set("originator", "pi");
	headers.set("user-agent", `pi (${platform()} ${release()}; ${arch()})`);
	headers.set("openai-beta", "responses=experimental");
	headers.set("x-codex-beta-features", mergeFeatureHeader(headers.get("x-codex-beta-features")));
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (requestId) {
		headers.set("session-id", requestId);
		headers.set("x-client-request-id", requestId);
	}
	return Object.fromEntries(headers.entries());
}

export function buildStandardCompactionHeaders(params: {
	apiKey: string;
	modelHeaders?: Model<Api>["headers"];
	headers?: Record<string, string>;
}): Record<string, string> {
	const headers = new Headers();
	for (const source of [params.modelHeaders, params.headers]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value !== null) headers.set(name, value);
		}
	}
	for (const name of [
		"chatgpt-account-id",
		"openai-beta",
		"originator",
		"session-id",
		"x-client-request-id",
		"x-codex-beta-features",
	]) headers.delete(name);
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return Object.fromEntries(headers.entries());
}

function contentText(item: ResponseItem): string {
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return "";
	return item.content
		.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
		.join("");
}

function hasEnvelope(text: string, start: string, end: string): boolean {
	const trimmed = text.trim();
	return trimmed.slice(0, start.length).toLowerCase() === start.toLowerCase()
		&& trimmed.slice(-end.length).toLowerCase() === end.toLowerCase();
}

function isInjectedContextText(text: string): boolean {
	const trimmed = text.trim();
	if (CONTEXT_ENVELOPES.some(([start, end]) => hasEnvelope(trimmed, start, end))) return true;
	if (/^<hook_prompt\s+hook_run_id=(?:"[^"]+"|'[^']+')\s*>[\s\S]*<\/hook_prompt>$/.test(trimmed)) return true;
	if (/^<external_[^>]+>[\s\S]*<\/external_[^>]+>$/.test(trimmed)) return true;
	if (trimmed.startsWith("<goal_context>") && trimmed.endsWith("</goal_context>")) return true;
	return /^<codex_internal_context\s+source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/.test(trimmed);
}

function canonicalRetainedUserPart(value: unknown): JsonObject | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "input_text" && typeof value.text === "string") {
		if (!value.text.trim() || isInjectedContextText(value.text)) return undefined;
		return { type: "input_text", text: value.text };
	}
	if (value.type !== "input_image" || typeof value.image_url !== "string") return undefined;
	// Pi serializes local user images as data URLs. Do not persist remote/signed URLs
	// that a downstream payload hook may have injected into the provider request.
	if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/i.test(value.image_url)) return undefined;
	if (value.detail !== undefined && !IMAGE_DETAILS.has(String(value.detail))) return undefined;
	return {
		type: "input_image",
		image_url: value.image_url,
		...(typeof value.detail === "string" ? { detail: value.detail } : {}),
	};
}

function canonicalRetainedUserItem(value: unknown): ResponseItem | undefined {
	if (!isRecord(value) || WIRE_ARTIFACT_TYPES.has(String(value.type)) || value.role !== "user") return undefined;
	if (value.type !== undefined && value.type !== "message") return undefined;
	const sourceContent = typeof value.content === "string"
		? [{ type: "input_text", text: value.content }]
		: value.content;
	if (!Array.isArray(sourceContent)) return undefined;
	const content = sourceContent.flatMap((part) => {
		const canonical = canonicalRetainedUserPart(part);
		return canonical ? [canonical] : [];
	});
	if (content.length === 0) return undefined;
	return { type: "message", role: "user", content };
}

function strictPersistedUserPart(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.type === "input_text") {
		return hasOnlyKeys(value, PERSISTED_USER_TEXT_KEYS) && typeof value.text === "string";
	}
	return value.type === "input_image"
		&& hasOnlyKeys(value, PERSISTED_USER_IMAGE_KEYS)
		&& typeof value.image_url === "string"
		&& (value.detail === undefined || typeof value.detail === "string");
}

function strictPersistedUserItem(value: unknown): ResponseItem | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, PERSISTED_USER_ITEM_KEYS)) return undefined;
	if (!Array.isArray(value.content) || !value.content.every(strictPersistedUserPart)) return undefined;
	const canonical = canonicalRetainedUserItem(value);
	return canonical && sameJson(canonical, value) ? canonical : undefined;
}

function truncateUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

function truncateUserItem(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
	const copy = cloneJson(item);
	let bytesLeft = Math.max(0, Math.floor(maxTokens) * 4);
	if (typeof copy.content === "string") {
		copy.content = truncateUtf8(copy.content, bytesLeft);
		return copy.content ? copy : undefined;
	}
	if (!Array.isArray(copy.content)) return undefined;
	const content = copy.content.flatMap((part) => {
		if (!isRecord(part) || typeof part.text !== "string") return isRecord(part) ? [part] : [];
		if (bytesLeft === 0) return [];
		const text = truncateUtf8(part.text, bytesLeft);
		bytesLeft -= Buffer.byteLength(text, "utf8");
		return text ? [{ ...part, text }] : [];
	});
	copy.content = content;
	return content.length > 0 ? copy : undefined;
}

export function retainRecentUserItems(
	input: ResponseItem[],
	maxTokens = RETAINED_USER_TOKEN_BUDGET,
): ResponseItem[] {
	let remaining = Math.max(0, Math.floor(maxTokens));
	const retainedReversed: ResponseItem[] = [];
	for (const candidate of [...input].reverse()) {
		if (remaining === 0) break;
		const item = canonicalRetainedUserItem(candidate);
		if (!item) continue;
		const tokens = Math.max(1, Math.ceil(Buffer.byteLength(contentText(item), "utf8") / 4));
		if (tokens <= remaining) {
			retainedReversed.push(item);
			remaining -= tokens;
			continue;
		}
		const truncated = truncateUserItem(item, remaining);
		if (truncated) retainedReversed.push(truncated);
		remaining = 0;
	}
	return retainedReversed.reverse();
}

function isArtifactShaped(value: unknown): value is JsonObject {
	return isRecord(value) && typeof value.type === "string" && WIRE_ARTIFACT_TYPES.has(value.type);
}

function canonicalWireCompactionItem(value: unknown): ResponseItem | undefined {
	if (!isArtifactShaped(value)) return undefined;
	if (typeof value.encrypted_content !== "string" || value.encrypted_content.trim() === "") return undefined;
	if (value.id !== undefined && value.id !== null && typeof value.id !== "string") return undefined;
	const metadata = value.internal_chat_message_metadata_passthrough;
	if (metadata !== undefined && metadata !== null && !isRecord(metadata)) return undefined;
	if (isRecord(metadata) && metadata.turn_id !== undefined && metadata.turn_id !== null && typeof metadata.turn_id !== "string") {
		return undefined;
	}
	return {
		type: "compaction",
		...(typeof value.id === "string" ? { id: value.id } : {}),
		encrypted_content: value.encrypted_content,
		...(isRecord(metadata)
			? { internal_chat_message_metadata_passthrough: typeof metadata.turn_id === "string" ? { turn_id: metadata.turn_id } : {} }
			: {}),
	};
}

function strictPersistedCompactionItem(value: unknown): ResponseItem | undefined {
	if (!isRecord(value) || value.type !== "compaction" || !hasOnlyKeys(value, PERSISTED_ARTIFACT_KEYS)) return undefined;
	if (typeof value.encrypted_content !== "string" || value.encrypted_content.trim() === "") return undefined;
	if (value.id !== undefined && typeof value.id !== "string") return undefined;
	const metadata = value.internal_chat_message_metadata_passthrough;
	if (metadata !== undefined) {
		if (!isRecord(metadata) || !hasOnlyKeys(metadata, PERSISTED_METADATA_KEYS)) return undefined;
		if (metadata.turn_id !== undefined && typeof metadata.turn_id !== "string") return undefined;
	}
	return cloneJson(value) as ResponseItem;
}

function parsePersistedReplacementHistory(value: unknown): ResponseItem[] | undefined {
	try {
		if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) return undefined;
		if (jsonBytes(value) > MAX_REPLACEMENT_HISTORY_BYTES) return undefined;
		const artifact = strictPersistedCompactionItem(value.at(-1));
		if (!artifact) return undefined;
		const prefix = value.slice(0, -1).map(strictPersistedUserItem);
		if (prefix.some((item) => item === undefined)) return undefined;
		const retained = prefix as ResponseItem[];
		if (!sameJson(retainRecentUserItems(retained), retained)) return undefined;
		return [...cloneJson(retained), artifact];
	} catch {
		return undefined;
	}
}

export function buildReplacementHistory(input: ResponseItem[], compactionItem: ResponseItem): ResponseItem[] {
	const artifact = canonicalWireCompactionItem(compactionItem);
	if (!artifact) throw new Error("OpenAI server compaction returned an invalid artifact");
	let history = [...retainRecentUserItems(input), artifact];
	while (history.length > 1 && jsonBytes(history) > MAX_REPLACEMENT_HISTORY_BYTES) history = history.slice(1);
	if (jsonBytes(history) > MAX_REPLACEMENT_HISTORY_BYTES) {
		throw new Error("OpenAI server compaction artifact exceeded the persistence limit");
	}
	return history;
}

const SENSITIVE_CANONICAL_KEYS = /(?:^|_)(?:auth|authorization|api_?key|client_?secret|private_?key|token|session_?token|oauth_?token|access_?token|refresh_?token|id_?token|auth_?token|account(?:_?id)?|chatgpt_?account_?id|cookies?|set_?cookie|credentials?|password|secret|headers?)(?:$|_)/i;

function normalizeCanonicalKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-z0-9]+/gi, "_")
		.toLowerCase();
}

function isSecretShapedString(value: string): boolean {
	return /Bearer\s+\S+/i.test(value)
		|| /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
		|| /\b(?:sk|rk|pk|key)-[A-Za-z0-9_-]{12,}\b/i.test(value);
}

const SENSITIVE_URL_QUERY_KEY = /(?:^|_)(?:auth|authorization|api_?key|key|token|secret|password|credential|signature|sig|access_?token|refresh_?token|x_?amz_?(?:credential|signature)|x_?goog_?(?:credential|signature))(?:$|_)/i;

function containsCredentialBearingUrl(value: string): boolean {
	for (const match of value.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
		try {
			const url = new URL(match[0]);
			if (url.username || url.password) return true;
			const parameterKeys = [
				...url.searchParams.keys(),
				...new URLSearchParams(url.hash.replace(/^#/, "")).keys(),
			];
			for (const key of parameterKeys) {
				if (SENSITIVE_URL_QUERY_KEY.test(normalizeCanonicalKey(key))) return true;
			}
		} catch {
			// A malformed URL is not transportable as a remote-resource field; other
			// credential detectors still apply to its surrounding string.
		}
	}
	return false;
}

function isSafeResponseId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 256
		&& /^[A-Za-z0-9._:-]+$/.test(value)
		&& !isSecretShapedString(value);
}

function canonicalOutputIsSafe(
	value: unknown,
	artifact: JsonObject,
	key = "",
	owner?: JsonObject,
): boolean {
	if (Array.isArray(value)) return value.every((item) => canonicalOutputIsSafe(item, artifact));
	if (isRecord(value)) {
		return Object.entries(value).every(([childKey, child]) => (
			!SENSITIVE_CANONICAL_KEYS.test(normalizeCanonicalKey(childKey))
			&& canonicalOutputIsSafe(child, artifact, childKey, value)
		));
	}
	if (typeof value !== "string") return true;
	if (key === "encrypted_content" && owner === artifact) return true;
	if (isSecretShapedString(value) || containsCredentialBearingUrl(value)) return false;
	const normalizedKey = normalizeCanonicalKey(key);
	if (/(?:^|_)(?:url|uri|href|link)$/i.test(normalizedKey) && /^https?:\/\//i.test(value)) return false;
	return true;
}

function parseStandardReplacementHistory(
	value: unknown,
	clone = true,
): ResponseItem[] | undefined {
	try {
		if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) return undefined;
		if (jsonBytes(value) > MAX_REPLACEMENT_HISTORY_BYTES) return undefined;
		const artifacts = value.filter(isArtifactShaped);
		if (artifacts.length !== 1 || value.at(-1) !== artifacts[0]) return undefined;
		const artifact = artifacts[0];
		if (typeof artifact.encrypted_content !== "string" || artifact.encrypted_content.trim() === "") return undefined;
		if (!canonicalOutputIsSafe(value, artifact)) return undefined;
		return (clone ? cloneJson(value) : value) as ResponseItem[];
	} catch {
		return undefined;
	}
}

export function parseStandardCompactionResponse(text: string): {
	replacementHistory: ResponseItem[];
	responseId?: string;
	rawUsage?: unknown;
} {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error(`OpenAI server compaction returned malformed JSON: ${safeDiagnostic(text)}`);
	}
	if (!isRecord(value)) throw new Error("OpenAI server compaction returned a non-object JSON response");
	if (value.error !== undefined && value.error !== null) {
		const failure = providerFailure(value, "provider error");
		throw new RemoteCompactionError(
			`OpenAI server compaction failed: ${failure.message}`,
			failure.retryable,
			failure.overload,
		);
	}
	// JSON.parse already created an unaliased output tree; persisted records still
	// use the defensive-clone path when they are loaded from session objects.
	const replacementHistory = parseStandardReplacementHistory(value.output, false);
	if (!replacementHistory) {
		const count = Array.isArray(value.output) ? value.output.filter(isArtifactShaped).length : 0;
		throw new Error(`OpenAI server compaction expected one final canonical artifact, received ${count}`);
	}
	if (value.id !== undefined && !isSafeResponseId(value.id)) {
		throw new Error("OpenAI server compaction returned an invalid response id");
	}
	return {
		replacementHistory,
		...(isSafeResponseId(value.id) ? { responseId: value.id } : {}),
		...(value.usage !== undefined ? { rawUsage: value.usage } : {}),
	};
}

function parseSseJson(text: string): JsonObject[] {
	const normalized = text.replace(/\r\n|\r/g, "\n");
	const events: JsonObject[] = [];
	let sawDone = false;
	for (const block of normalized.split("\n\n")) {
		if (block === "") continue;
		const dataLines: string[] = [];
		for (const line of block.split("\n")) {
			// Standard SSE allows event/id/retry fields and ":" comment lines beside data.
			// Live Codex compaction streams currently emit `event: response.*` before each data payload
			// and often omit the terminal `data: [DONE]` marker when the HTTP body ends cleanly.
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
				continue;
			}
			if (line === "" || line.startsWith(":") || /^[^:\u0000]+(?::.*)?$/.test(line)) continue;
			throw new Error("OpenAI server compaction returned malformed SSE framing");
		}
		if (dataLines.length === 0) continue;
		const data = dataLines.join("\n").trim();
		if (!data) throw new Error("OpenAI server compaction returned an empty SSE data event");
		if (sawDone) throw new Error("OpenAI server compaction returned data after [DONE]");
		if (data === "[DONE]") {
			sawDone = true;
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data) as unknown;
		} catch {
			throw new Error(`OpenAI server compaction returned malformed SSE JSON: ${safeDiagnostic(data)}`);
		}
		if (!isRecord(parsed)) throw new Error("OpenAI server compaction returned a non-object SSE event");
		events.push(parsed);
	}
	// [DONE] remains accepted when present, but completion is enforced by parseCompactionSse.
	return events;
}

export function safeDiagnostic(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value);
	return raw
		.replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-token>")
		.replace(/\b(?:sk|rk|pk|key)-[A-Za-z0-9_-]{12,}\b/gi, "<redacted-key>")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_DIAGNOSTIC_CHARS);
}

function readWireArtifact(value: unknown, location: string): ResponseItem | undefined {
	if (!isArtifactShaped(value)) return undefined;
	const artifact = canonicalWireCompactionItem(value);
	if (!artifact) throw new Error(`OpenAI server compaction returned an invalid ${location} artifact`);
	return artifact;
}

function providerFailure(value: unknown, fallback: string): { message: string; retryable: boolean; overload: boolean } {
	const record = isRecord(value) ? value : undefined;
	const nested = record && isRecord(record.error) ? record.error : undefined;
	const code = [nested?.code, record?.code].find((candidate) => typeof candidate === "string");
	const message = [nested?.message, record?.message].find((candidate) => typeof candidate === "string") ?? fallback;
	const overload = typeof code === "string" && RETRYABLE_PROVIDER_CODES.has(code);
	return { message: safeDiagnostic(message), retryable: overload, overload };
}

export function parseCompactionSse(text: string): {
	compactionItem: ResponseItem;
	responseId?: string;
	rawUsage?: unknown;
} {
	let completionCount = 0;
	let sawLifecycleEvent = false;
	let responseId: string | undefined;
	let rawUsage: unknown;
	const streamedItems: ResponseItem[] = [];
	const completedItems: ResponseItem[] = [];

	for (const event of parseSseJson(text)) {
		if (completionCount > 0) {
			if (event.type === "response.completed") {
				completionCount++;
				continue;
			}
			throw new Error("OpenAI server compaction returned data after completion");
		}
		if (typeof event.type === "string" && event.type.startsWith("response.")) sawLifecycleEvent = true;
		if (event.type === "error") {
			const failure = providerFailure(event, "provider error");
			throw new RemoteCompactionError(
				`OpenAI server compaction failed: ${failure.message}`,
				failure.retryable,
				failure.overload,
			);
		}
		if (event.type === "response.failed") {
			const response = isRecord(event.response) ? event.response : undefined;
			const failure = providerFailure(response, "response failed");
			throw new RemoteCompactionError(
				`OpenAI server compaction failed: ${failure.message}`,
				failure.retryable,
				failure.overload,
			);
		}
		if (event.type === "response.output_item.done") {
			const item = readWireArtifact(event.item, "streamed");
			if (item) streamedItems.push(item);
			continue;
		}
		if (event.type === "response.completed") {
			completionCount++;
			const response = isRecord(event.response) ? event.response : undefined;
			if (typeof response?.status === "string" && response.status !== "completed") {
				throw new Error(`OpenAI server compaction completed with invalid status ${safeDiagnostic(response.status)}`);
			}
			if (response?.error !== undefined && response.error !== null) {
				throw new Error("OpenAI server compaction completed with an error");
			}
			if (typeof response?.id === "string") responseId = response.id;
			rawUsage = response?.usage;
			if (response?.output !== undefined && !Array.isArray(response.output)) {
				throw new Error("OpenAI server compaction returned an invalid completed output");
			}
			for (const candidate of response?.output ?? []) {
				const item = readWireArtifact(candidate, "completed");
				if (item) completedItems.push(item);
			}
		}
	}

	if (completionCount === 0) {
		throw new RemoteCompactionError(
			"OpenAI server compaction stream ended before completion",
			sawLifecycleEvent,
		);
	}
	if (completionCount !== 1) throw new Error(`OpenAI server compaction expected one completion, received ${completionCount}`);
	if (streamedItems.length > 1 || completedItems.length > 1) {
		throw new Error(`OpenAI server compaction expected one artifact, received ${streamedItems.length + completedItems.length}`);
	}
	const streamed = streamedItems[0];
	const completed = completedItems[0];
	if (streamed && completed && !sameJson(streamed, completed)) {
		throw new Error("OpenAI server compaction returned conflicting streamed and completed artifacts");
	}
	const artifact = streamed ?? completed;
	if (!artifact) throw new Error("OpenAI server compaction expected one artifact, received 0");
	return { compactionItem: cloneJson(artifact), responseId, rawUsage };
}

async function readBoundedResponse(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new RemoteResponseSizeError();
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		totalBytes += value.byteLength;
		if (totalBytes > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new RemoteResponseSizeError();
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

export function parseRemoteUsage(model: Model<any>, value: unknown): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const hasUsage = [value.input_tokens, value.output_tokens, value.total_tokens].some(
		(token) => token !== undefined,
	);
	if (!hasUsage) return undefined;
	const details = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
	const rawCounts = [
		value.input_tokens,
		value.output_tokens,
		value.total_tokens,
		details?.cached_tokens,
		details?.cache_creation_tokens,
		details?.cache_write_tokens,
	].filter((token) => token !== undefined);
	if (!rawCounts.every(isTokenCount)) return undefined;
	const inputTokens = finiteNonNegative(value.input_tokens);
	const outputTokens = finiteNonNegative(value.output_tokens);
	const cacheRead = finiteNonNegative(details?.cached_tokens);
	const cacheWrite = finiteNonNegative(details?.cache_creation_tokens ?? details?.cache_write_tokens);
	if (cacheRead + cacheWrite > inputTokens) return undefined;
	const reportedTotal = finiteNonNegative(value.total_tokens);
	if (reportedTotal > 0 && reportedTotal < inputTokens + outputTokens) return undefined;
	const usage: Usage = {
		input: inputTokens - cacheRead - cacheWrite,
		output: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: reportedTotal || inputTokens + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function isPreparedProviderPayload(value: unknown): value is JsonObject & { input: ResponseItem[] } {
	return isRecord(value) && Array.isArray(value.input) && value.input.every(isRecord);
}

export function buildPreparedCompactionRequest(
	preparedPayload: unknown,
	tailInput: ResponseItem[],
): { body: JsonObject; compactedInput: ResponseItem[] } {
	if (!isPreparedProviderPayload(preparedPayload)) {
		throw new Error("the final Codex provider payload did not contain full Responses input");
	}
	const request = cloneJson(preparedPayload);
	const compactedInput = [...cloneJson(preparedPayload.input), ...cloneJson(tailInput)] as ResponseItem[];
	request.input = [...compactedInput, { type: "compaction_trigger" }];
	delete request.previous_response_id;
	return { body: request, compactedInput };
}

export function buildStandardCompactionRequest(
	preparedPayload: unknown,
	tailInput: ResponseItem[],
): { body: JsonObject; compactedInput: ResponseItem[] } {
	if (!isPreparedProviderPayload(preparedPayload) || typeof preparedPayload.model !== "string") {
		throw new Error("the final standard Responses payload did not contain a model and full input");
	}
	const compactedInput = [...cloneJson(preparedPayload.input), ...cloneJson(tailInput)] as ResponseItem[];
	const body: JsonObject = { model: preparedPayload.model, input: compactedInput };
	for (const key of ["instructions", "prompt_cache_key"] as const) {
		const value = preparedPayload[key];
		if (Object.hasOwn(preparedPayload, key) && value !== undefined) body[key] = cloneJson(value);
	}
	return { body, compactedInput };
}

function streamsForAdapter(adapter: CompactionAdapterKind): ProviderStreams {
	return adapter === "codex-trigger-sse" ? openAICodexResponsesApi() : openAIResponsesApi();
}

async function convertMessages(
	model: Model<any>,
	messages: Parameters<typeof convertToLlm>[0],
	tools: Tool[] = [],
	adapter: CompactionAdapterKind = "codex-trigger-sse",
): Promise<ResponseItem[]> {
	let capturedPayload: unknown;
	const stream = streamsForAdapter(adapter).streamSimple(
		{ ...model, baseUrl: PAYLOAD_CAPTURE_BASE_URL } as never,
		{ systemPrompt: "", messages: convertToLlm(messages), tools },
		{
			apiKey: adapter === "codex-trigger-sse" ? PAYLOAD_CAPTURE_TOKEN : "capture-only",
			signal: new AbortController().signal,
			onPayload: (payload) => {
				capturedPayload = payload;
				throw new Error("Responses payload captured");
			},
		},
	);
	for await (const _event of stream) {
		// Capture delegates filtering and provider-native reasoning/tool serialization to Pi.
	}
	if (!isPreparedProviderPayload(capturedPayload)) throw new Error("Unable to capture Responses input");
	return cloneJson(capturedPayload.input);
}

export async function resolveFinalProviderPayload(
	payload: unknown,
	model: Model<Api>,
	onPayload: SimpleStreamOptions["onPayload"],
): Promise<unknown> {
	const rewritten = await onPayload?.(payload, model);
	return rewritten === undefined ? payload : rewritten;
}

// The provider hook and its later onPayload callback run in one async chain,
// but multiple streams can overlap. AsyncLocalStorage keeps each provisional
// replay plan attached to its own stream while the latest successful normal
// snapshot remains globally session-local.
function createPayloadStateController() {
	const storage = new AsyncLocalStorage<RequestScope>();
	let generation = 0;
	let nextInvocationSequence = 0;
	let newestNormalSequence = 0;
	let preparedSnapshot: TaggedPreparedPayloadSnapshot | undefined;

	return {
		runRequest<T>(callback: () => T): T {
			const scope: RequestScope = {
				generation,
				invocationSequence: ++nextInvocationSequence,
				consumed: false,
			};
			return storage.run(scope, callback);
		},
		prepareRequest(plan: RequestPlanDraft): boolean {
			const scope = storage.getStore();
			if (!scope || scope.generation !== generation || scope.consumed) return false;
			scope.plan = {
				...plan,
				generation: scope.generation,
				invocationSequence: scope.invocationSequence,
			} as RequestPlan;
			if (plan.mode === "normal" && scope.invocationSequence >= newestNormalSequence) {
				newestNormalSequence = scope.invocationSequence;
				preparedSnapshot = undefined;
			}
			return true;
		},
		consumeRequest(): { scope: RequestScope; plan?: RequestPlan } | undefined {
			const scope = storage.getStore();
			if (!scope || scope.consumed) return undefined;
			scope.consumed = true;
			return { scope, plan: scope.plan };
		},
		isCurrentGeneration(candidate: number): boolean {
			return candidate === generation;
		},
		captureSnapshot(plan: RequestPlanBase, payload: JsonObject): void {
			if (
				plan.generation !== generation
				|| plan.mode !== "normal"
				|| plan.invocationSequence < newestNormalSequence
			) return;
			preparedSnapshot = {
				sessionId: plan.sessionId,
				leafId: plan.leafId,
				identity: cloneJson(plan.identity),
				payload: cloneJson(payload),
				generation,
				invocationSequence: plan.invocationSequence,
			};
		},
		invalidateSnapshot(plan: RequestPlanBase): void {
			if (plan.generation === generation && plan.invocationSequence >= newestNormalSequence) {
				preparedSnapshot = undefined;
			}
		},
		getSnapshot(): PreparedPayloadSnapshot | undefined {
			if (!preparedSnapshot || preparedSnapshot.generation !== generation) return undefined;
			return cloneJson({
				sessionId: preparedSnapshot.sessionId,
				leafId: preparedSnapshot.leafId,
				identity: preparedSnapshot.identity,
				payload: preparedSnapshot.payload,
			});
		},
		reset(): void {
			generation++;
			newestNormalSequence = 0;
			preparedSnapshot = undefined;
		},
	};
}

function streamWithPreparedPayloadCapture(
	streams: ProviderStreams,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	state: ReturnType<typeof createPayloadStateController>,
	finalizePayload: (
		payload: unknown,
		model: Model<Api>,
		sessionId: string | undefined,
		request: ReturnType<ReturnType<typeof createPayloadStateController>["consumeRequest"]>,
	) => unknown,
) {
	if (!featureEnabled(process.env[SERVER_COMPACTION_ENV])) return streams.streamSimple(model as never, context, options);
	const forceCodexNativeLane = isSupportedCodexModel(model);
	return state.runRequest(() => streams.streamSimple(model as never, context, {
		...options,
		...(forceCodexNativeLane
			? {
				headers: withRemoteFeatureProviderHeaders(model.headers, options?.headers),
				transport: "sse" as const,
			}
			: {}),
		onPayload: async (payload: unknown, preparedModel: Model<Api>) => {
			const finalPayload = await resolveFinalProviderPayload(payload, preparedModel, options?.onPayload);
			return finalizePayload(finalPayload, preparedModel, options?.sessionId, state.consumeRequest());
		},
	} as never));
}

export function extractServerCompactionDetails(value: unknown): ServerCompactionDetails | undefined {
	try {
		if (!isRecord(value) || value.strategy !== SERVER_COMPACTION_STRATEGY) return undefined;
		if (
			typeof value.provider !== "string"
			|| typeof value.api !== "string"
			|| typeof value.model !== "string"
			|| value.model.length === 0
			|| typeof value.baseUrl !== "string"
			|| typeof value.createdAt !== "string"
		) return undefined;
		if (value.responseId !== undefined && !isSafeResponseId(value.responseId)) return undefined;
		const legacyCodex = value.adapter === undefined
			&& value.provider === "openai-codex"
			&& value.api === "openai-codex-responses";
		const adapter = legacyCodex ? "codex-trigger-sse" : value.adapter;
		if (adapter !== "codex-trigger-sse" && adapter !== "standard-responses-json") return undefined;
		const candidate = {
			provider: value.provider,
			api: value.api,
			id: value.model,
			baseUrl: value.baseUrl,
		};
		const backend = resolveCompactionBackend(candidate);
		if (!backend || backend.adapter !== adapter) return undefined;
		const replacementHistory = adapter === "codex-trigger-sse"
			? parsePersistedReplacementHistory(value.replacementHistory)
			: parseStandardReplacementHistory(value.replacementHistory);
		if (!replacementHistory) return undefined;
		return {
			strategy: SERVER_COMPACTION_STRATEGY,
			adapter,
			provider: value.provider,
			api: value.api,
			model: value.model,
			baseUrl: backend.baseUrl,
			replacementHistory,
			createdAt: value.createdAt,
			...(typeof value.responseId === "string" ? { responseId: value.responseId } : {}),
			...(isUsage(value.usage) ? { usage: cloneJson(value.usage) } : {}),
		};
	} catch {
		return undefined;
	}
}

function latestCompaction(branch: SessionEntry[]): { entry: Extract<SessionEntry, { type: "compaction" }>; index: number } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "compaction") return { entry, index };
	}
	return undefined;
}

function classifyLatestCheckpoint(branch: SessionEntry[]): LatestCheckpoint {
	const latest = latestCompaction(branch);
	if (!latest) return { kind: "none" };
	const details = extractServerCompactionDetails(latest.entry.details);
	if (details && latest.entry.summary === SERVER_COMPACTION_SHIM_SUMMARY) {
		return { kind: "native", ...latest, details };
	}
	const hasCurrentStrategy = isRecord(latest.entry.details)
		&& latest.entry.details.strategy === SERVER_COMPACTION_STRATEGY;
	if (latest.entry.summary === SERVER_COMPACTION_SHIM_SUMMARY || hasCurrentStrategy) {
		return { kind: "malformed", ...latest };
	}
	return { kind: "plain", ...latest };
}

async function reconstructReplayHistoryFromCheckpoint(
	checkpoint: LatestCheckpoint,
	branch: SessionEntry[],
	model: Model<any>,
	tools: Tool[] = [],
): Promise<ResponseItem[] | undefined> {
	if (checkpoint.kind === "none" || checkpoint.kind === "plain") return undefined;
	if (checkpoint.kind === "malformed") {
		throw new Error("the latest native compaction checkpoint is missing or invalid");
	}
	const current = identityFor(model);
	if (!replayIdentitiesMatch(checkpoint.details, current)) {
		throw new Error("the latest native compaction checkpoint belongs to a different provider endpoint or model");
	}
	const trailingMessages = branch
		.slice(checkpoint.index + 1)
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	return [
		...cloneJson(checkpoint.details.replacementHistory),
		...(await convertMessages(model, trailingMessages, tools, checkpoint.details.adapter)),
	];
}

export async function reconstructReplayHistory(
	branch: SessionEntry[],
	model: Model<any>,
	tools: Tool[] = [],
): Promise<ResponseItem[] | undefined> {
	return reconstructReplayHistoryFromCheckpoint(classifyLatestCheckpoint(branch), branch, model, tools);
}

function validateSnapshotForCompaction(
	snapshot: PreparedPayloadSnapshot,
	branch: SessionEntry[],
	model: Model<any>,
	sessionId: string,
): number {
	if (!sessionId || snapshot.sessionId !== sessionId) {
		throw new Error("the final provider payload snapshot belongs to a different session");
	}
	const current = identityFor(model);
	if (!identitiesMatch(snapshot.identity, current)) {
		throw new Error("the final provider payload snapshot belongs to a different model or endpoint");
	}
	if (snapshot.payload.model !== current.model) {
		throw new Error("the final provider payload snapshot changed the selected model");
	}
	if (snapshot.leafId === null) return -1;
	const matches = branch.flatMap((entry, index) => (entry.id === snapshot.leafId ? [index] : []));
	if (matches.length !== 1) throw new Error("the final provider payload snapshot is not on the active branch");
	const leafIndex = matches[0] as number;
	for (let index = leafIndex + 1; index < branch.length; index++) {
		if (branch[index]?.parentId !== branch[index - 1]?.id) {
			throw new Error("the final provider payload snapshot is not an ancestor of the active branch");
		}
	}
	return leafIndex;
}

export async function buildCompactionRequestFromSnapshot(
	snapshot: PreparedPayloadSnapshot,
	branch: SessionEntry[],
	model: Model<any>,
	sessionId: string,
	tools: Tool[] = [],
): Promise<{ body: JsonObject; compactedInput: ResponseItem[] }> {
	const leafIndex = validateSnapshotForCompaction(snapshot, branch, model, sessionId);
	const tailMessages = branch
		.slice(leafIndex + 1)
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	const tailInput = await convertMessages(model, tailMessages, tools, snapshot.identity.adapter);
	return snapshot.identity.adapter === "codex-trigger-sse"
		? buildPreparedCompactionRequest(snapshot.payload, tailInput)
		: buildStandardCompactionRequest(snapshot.payload, tailInput);
}

function responseItemText(item: unknown): string {
	if (!isRecord(item)) return "";
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return "";
	return item.content
		.flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}

function isSummarizationInstruction(text: string): boolean {
	return /you are a context summarization assistant\b/i.test(text)
		&& /only output the structured summary\b/i.test(text);
}

function isStructuredConversationEnvelope(text: string): boolean {
	const start = text.search(/<conversation>/i);
	if (start < 0 || text.slice(0, start).trim() !== "") return false;
	const closeMatch = /<\/conversation>/i.exec(text.slice(start));
	if (!closeMatch) return false;
	const after = text.slice(start + (closeMatch.index ?? 0) + closeMatch[0].length);
	const fullSummary = /## Goal\b/.test(after) && /## Progress\b/.test(after) && /## Critical Context\b/.test(after);
	const turnPrefix = /## Original Request\b/.test(after)
		&& /## Early Progress\b/.test(after)
		&& /## Context for Suffix\b/.test(after);
	return fullSummary || turnPrefix;
}

export function isPiSummarizationPayload(payload: unknown): boolean {
	if (!isPreparedProviderPayload(payload)) return false;
	let hasInstruction = typeof payload.instructions === "string" && isSummarizationInstruction(payload.instructions);
	let hasEnvelope = false;
	for (const item of payload.input) {
		const text = responseItemText(item);
		if ((item.role === "system" || item.role === "developer") && isSummarizationInstruction(text)) {
			hasInstruction = true;
		}
		if (item.role === "user" && isStructuredConversationEnvelope(text)) hasEnvelope = true;
	}
	return hasInstruction && hasEnvelope;
}

function replayWindowAt(input: unknown[], replayHistory: ResponseItem[], index: number): boolean {
	if (index + replayHistory.length > input.length) return false;
	for (let offset = 0; offset < replayHistory.length; offset++) {
		if (!sameJson(input[index + offset], replayHistory[offset])) return false;
	}
	return true;
}

export function injectReplayIntoSummarizationPayload(
	payload: unknown,
	replayHistory: ResponseItem[],
	authoritativeInput?: ResponseItem[],
): JsonObject | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
	// Pi's compactor may retry the summary with a fresh request and may already
	// contain a provisional replay. Rebuild input from the original summary
	// envelope so downstream hooks cannot duplicate or replace that window.
	const source = cloneJson(authoritativeInput ?? payload.input);
	const input: unknown[] = [];
	for (let index = 0; index < source.length;) {
		if (replayHistory.length > 0 && replayWindowAt(source, replayHistory, index)) {
			index += replayHistory.length;
			continue;
		}
		const item = source[index];
		if (isArtifactShaped(item)) {
			index++;
			continue;
		}
		input.push(item);
		index++;
	}
	let insertAt = 0;
	while (insertAt < input.length) {
		const item = input[insertAt];
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) break;
		insertAt++;
	}
	return {
		...payload,
		input: [...input.slice(0, insertAt), ...cloneJson(replayHistory), ...input.slice(insertAt)],
	};
}

export function rewritePayload(payload: unknown, replayHistory: ResponseItem[]): JsonObject | undefined {
	if (!isRecord(payload)) return undefined;
	const rewritten: JsonObject = { ...payload, input: cloneJson(replayHistory) };
	delete rewritten.messages;
	delete rewritten.previous_response_id;
	return rewritten;
}

function responseErrorDiagnostic(text: string): string | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		if (!isRecord(value)) return undefined;
		const error = isRecord(value.error) ? value.error : undefined;
		const message = error?.message ?? value.message ?? value.detail;
		return typeof message === "string" ? safeDiagnostic(message) : undefined;
	} catch {
		return undefined;
	}
}

type RemoteCompactionRequest = {
	adapter: CompactionAdapterKind;
	url: string;
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	sessionId: string;
	body: JsonObject;
	compactedInput: ResponseItem[];
	signal: AbortSignal;
	fetchFn: FetchLike;
	sleepFn: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

async function sleepWithSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason;
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function requestServerCompactionAttempt(
	params: RemoteCompactionRequest,
	signal: AbortSignal,
	bodyText: string,
): Promise<RemoteCompactionResult> {
	let response: Response;
	try {
		const headers = params.adapter === "codex-trigger-sse"
			? buildCodexCompactionHeaders({ ...params, modelHeaders: params.model.headers })
			: buildStandardCompactionHeaders({ ...params, modelHeaders: params.model.headers });
		response = await params.fetchFn(params.url, {
			method: "POST",
			headers,
			body: bodyText,
			signal,
			redirect: "error",
		});
	} catch (error) {
		if (signal.aborted) throw error;
		throw new RemoteCompactionError(
			`OpenAI server compaction transport failed: ${safeDiagnostic(error)}`,
			true,
		);
	}
	let responseText: string;
	try {
		responseText = await readBoundedResponse(response);
	} catch (error) {
		if (signal.aborted || error instanceof RemoteResponseSizeError) throw error;
		throw new RemoteCompactionError(
			`OpenAI server compaction response stream failed: ${safeDiagnostic(error)}`,
			true,
		);
	}
	if (!response.ok) {
		const diagnostic = responseErrorDiagnostic(responseText);
		throw new RemoteCompactionError(
			`OpenAI server compaction failed with HTTP ${response.status} ${response.statusText}${diagnostic ? `: ${diagnostic}` : ""}`.trim(),
			RETRYABLE_HTTP_STATUSES.has(response.status),
		);
	}
	if (params.adapter === "standard-responses-json") {
		const parsed = parseStandardCompactionResponse(responseText);
		const usage = parseRemoteUsage(params.model, parsed.rawUsage);
		return {
			replacementHistory: parsed.replacementHistory,
			...(parsed.responseId ? { responseId: parsed.responseId } : {}),
			...(usage ? { usage } : {}),
		};
	}
	const parsed = parseCompactionSse(responseText);
	const usage = parseRemoteUsage(params.model, parsed.rawUsage);
	return {
		replacementHistory: buildReplacementHistory(params.compactedInput, parsed.compactionItem),
		...(parsed.responseId ? { responseId: parsed.responseId } : {}),
		...(usage ? { usage } : {}),
	};
}

async function requestServerCompaction(params: RemoteCompactionRequest): Promise<RemoteCompactionResult> {
	const signal = AbortSignal.any([params.signal, AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)]);
	const bodyText = JSON.stringify(params.body);
	let lastError: unknown;
	for (let attempt = 1; attempt <= REMOTE_COMPACTION_MAX_ATTEMPTS; attempt++) {
		try {
			return await requestServerCompactionAttempt(params, signal, bodyText);
		} catch (error) {
			lastError = error;
			if (
				signal.aborted
				|| !(error instanceof RemoteCompactionError)
				|| !error.retryable
				|| attempt === REMOTE_COMPACTION_MAX_ATTEMPTS
			) throw error;
			const baseDelay = error.overload
				? REMOTE_COMPACTION_OVERLOAD_RETRY_BASE_DELAY_MS
				: REMOTE_COMPACTION_RETRY_BASE_DELAY_MS;
			await params.sleepFn(baseDelay * 2 ** (attempt - 1), signal);
		}
	}
	throw lastError;
}

export function formatCompactionUsage(usage: Usage | undefined): string | undefined {
	if (!usage) return undefined;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const ratio = input > 0 ? `${((usage.cacheRead / input) * 100).toFixed(1)}%` : "0.0%";
	const tokens = (value: number) => Math.round(value).toLocaleString("en-US");
	return `Compaction V2 · input ${tokens(input)} · cache read ${tokens(usage.cacheRead)} (${ratio}) · cache write ${tokens(usage.cacheWrite)} · output ${tokens(usage.output)}`;
}

function renderCompactionDisplay(data: ServerCompactionDisplayData, theme: Parameters<Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>[2]) {
	const container = new Container();
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction]")), 0, 0));
	box.addChild(new Text(`\n${theme.fg("customMessageText", SERVER_COMPACTION_DISPLAY_TEXT)}`, 0, 0));
	container.addChild(box);
	const usage = formatCompactionUsage(data.usage);
	if (usage) container.addChild(new Text(theme.fg("dim", `  ${usage}`), 0, 0));
	const render = container.render.bind(container);
	container.render = (width) => render(width).map((line) => truncateToWidth(line, width, ""));
	return container;
}

function conversionToolCatalog(pi: ExtensionAPI): Tool[] {
	// This catalog is used only while converting branch-tail tool-search records;
	// the remote request's tool list and order come from the exact prepared snapshot.
	// Include inactive definitions because a historical addedToolNames record may
	// refer to a tool that is no longer active at the current leaf.
	return pi.getAllTools().map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function createOpenAIServerCompactionExtension(dependencies: Dependencies = {}) {
	const fetchFn: FetchLike = dependencies.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
	const sleepFn = dependencies.sleepFn ?? sleepWithSignal;

	return function openaiServerCompaction(pi: ExtensionAPI): void {
		const state = createPayloadStateController();

		const terminalizePayload = (
			payload: unknown,
			preparedModel: Model<Api>,
			sessionId: string | undefined,
			request: ReturnType<typeof state.consumeRequest>,
		): unknown => {
			const plan = request?.plan;
			if (!plan) return payload;
			const ownsNativeHistory = plan.kind === "block" || plan.replayHistory !== undefined;
			if (plan.generation !== request?.scope.generation || !state.isCurrentGeneration(plan.generation)) {
				if (ownsNativeHistory) throw new Error("OpenAI native compaction request lifecycle changed before transport");
				state.invalidateSnapshot(plan);
				return payload;
			}
			if (plan.kind === "block") throw new Error(plan.error);
			let preparedIdentity: NativeIdentity | undefined;
			try {
				preparedIdentity = identityFor(preparedModel);
			} catch (error) {
				if (ownsNativeHistory) throw new Error(`OpenAI native compaction model identity failed: ${safeDiagnostic(error)}`);
			}
			if (!preparedIdentity || !identitiesMatch(plan.identity, preparedIdentity) || !sessionId || sessionId !== plan.sessionId) {
				if (ownsNativeHistory) {
					throw new Error("OpenAI native compaction request metadata did not match the replay owner");
				}
				state.invalidateSnapshot(plan);
				return payload;
			}
			if (!isPreparedProviderPayload(payload)) {
				if (ownsNativeHistory) throw new Error("OpenAI native compaction received a malformed final provider payload");
				state.invalidateSnapshot(plan);
				return payload;
			}
			if (payload.model !== preparedIdentity.model) {
				if (ownsNativeHistory) throw new Error("OpenAI native compaction final payload changed the selected model");
				state.invalidateSnapshot(plan);
				return payload;
			}
			if (plan.mode === "summarization") {
				if (!isPiSummarizationPayload(payload)) {
					if (ownsNativeHistory) throw new Error("OpenAI native compaction lost the Pi summarization payload envelope");
					return payload;
				}
				if (!plan.replayHistory) return payload;
				const rewritten = injectReplayIntoSummarizationPayload(
					payload,
					plan.replayHistory,
					plan.originalSummarizerInput,
				);
				if (!rewritten || !isPiSummarizationPayload(rewritten)) {
					throw new Error("OpenAI native compaction could not enforce summarizer replay on the final provider payload");
				}
				return rewritten;
			}
			if (isPiSummarizationPayload(payload)) {
				if (ownsNativeHistory) throw new Error("OpenAI native compaction request mode changed before transport");
				state.invalidateSnapshot(plan);
				return payload;
			}
			const terminalPayload = plan.replayHistory ? rewritePayload(payload, plan.replayHistory) : payload;
			if (!terminalPayload || !isPreparedProviderPayload(terminalPayload)) {
				if (ownsNativeHistory) throw new Error("OpenAI native compaction could not enforce replay on the final provider payload");
				state.invalidateSnapshot(plan);
				return payload;
			}
			state.captureSnapshot(plan, terminalPayload);
			return terminalPayload;
		};

		const decorateProvider = (streams: ProviderStreams) => (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) => streamWithPreparedPayloadCapture(streams, model, context, options, state, terminalizePayload);

		pi.registerProvider("openai-codex", {
			api: "openai-codex-responses",
			streamSimple: decorateProvider(openAICodexResponsesApi()),
		});
		for (const provider of STANDARD_RESPONSES_MODELS.keys()) {
			pi.registerProvider(provider, {
				api: "openai-responses",
				streamSimple: decorateProvider(openAIResponsesApi()),
			});
		}

		pi.registerEntryRenderer<ServerCompactionDisplayData>(
			SERVER_COMPACTION_DISPLAY_ENTRY_TYPE,
			(entry, _options, theme) => entry.data
				? renderCompactionDisplay(entry.data, theme)
				: new Text(theme.fg("warning", "Native Responses compaction display unavailable"), 0, 0),
		);

		pi.on("session_start", state.reset);
		pi.on("session_tree", state.reset);
		pi.on("model_select", state.reset);
		pi.on("session_shutdown", state.reset);

		pi.on("session_before_compact", async (event, ctx) => {
			if (!featureEnabled(process.env[SERVER_COMPACTION_ENV])) return undefined;
			const checkpoint = classifyLatestCheckpoint(event.branchEntries);
			if (!isDecoratedApiModel(ctx.model)) {
				if (checkpoint.kind === "native" || checkpoint.kind === "malformed") {
					if (ctx.hasUI) ctx.ui.notify("Native Responses compaction requires its compatible provider endpoint and model; compaction was cancelled.", "error");
					return { cancel: true };
				}
				return undefined;
			}
			if (event.signal.aborted) return { cancel: true };
			const model = ctx.model;
			const sessionId = ctx.sessionManager.getSessionId();
			if (checkpoint.kind === "malformed") {
				const message = "Native Responses compaction replay failed: the latest checkpoint is missing or invalid";
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				return { cancel: true };
			}
			if (!isSupportedServerCompactionModel(model)) {
				if (checkpoint.kind === "native" && ctx.hasUI) {
					ctx.ui.notify("Native Responses compaction cannot continue on this provider endpoint or model; compaction was cancelled.", "error");
				}
				return checkpoint.kind === "native" ? { cancel: true } : undefined;
			}
			if (event.customInstructions?.trim() && ctx.hasUI) {
				ctx.ui.notify("Responses compaction V2 uses the active session instructions and ignores custom /compact guidance.", "warning");
			}

			try {
				const snapshot = state.getSnapshot();
				if (!snapshot) throw new Error("no exact final Responses provider payload is available for this branch");
				// Snapshot ownership is established before extension auth or transport is touched.
				const tools = conversionToolCatalog(pi);
				const request = await buildCompactionRequestFromSnapshot(snapshot, event.branchEntries, model, sessionId, tools);
				if (event.signal.aborted) return { cancel: true };
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) throw new Error("Responses provider authentication is unavailable");
				if (event.signal.aborted) return { cancel: true };
				const backend = resolveCompactionBackend(model);
				if (!backend) throw new Error("the active model uses an unsupported Responses compaction endpoint");
				const remote = await requestServerCompaction({
					adapter: backend.adapter,
					url: backend.compactionUrl,
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					sessionId,
					body: request.body,
					compactedInput: request.compactedInput,
					signal: event.signal,
					fetchFn,
					sleepFn,
				});
				const identity = identityFor(model);
				const details: ServerCompactionDetails = {
					strategy: SERVER_COMPACTION_STRATEGY,
					...identity,
					replacementHistory: remote.replacementHistory,
					createdAt: new Date().toISOString(),
					...(remote.responseId ? { responseId: remote.responseId } : {}),
					...(remote.usage ? { usage: remote.usage } : {}),
				};
				return {
					compaction: {
						summary: SERVER_COMPACTION_SHIM_SUMMARY,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details,
						...(remote.usage ? { usage: remote.usage } : {}),
					},
				};
			} catch (error) {
				if (event.signal.aborted) return { cancel: true };
				// The native-checkpoint branch cancels here: Pi's hookless fresh-ID
				// summarizer cannot be safely correlated with this session.
				const message = `OpenAI native compaction unavailable; ${checkpoint.kind === "native"
					? "readable Pi fallback is unsafe after an opaque checkpoint, so compaction was cancelled"
					: "Pi compaction will run"}. ${safeDiagnostic(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, checkpoint.kind === "native" ? "error" : "warning");
				return checkpoint.kind === "native" ? { cancel: true } : undefined;
			}
		});

		pi.on("session_compact", (event, ctx) => {
			state.reset();
			if (!event.fromExtension) return;
			// Pi 0.83 may report an older same-summary entry; the active branch is authoritative.
			const checkpoint = classifyLatestCheckpoint(ctx.sessionManager.getBranch());
			if (checkpoint.kind !== "native") return;
			pi.appendEntry(SERVER_COMPACTION_DISPLAY_ENTRY_TYPE, {
				...(checkpoint.details.usage ? { usage: checkpoint.details.usage } : {}),
			} satisfies ServerCompactionDisplayData);
		});

		pi.on("before_provider_request", async (event, ctx) => {
			if (!featureEnabled(process.env[SERVER_COMPACTION_ENV]) || !isDecoratedApiModel(ctx.model)) return undefined;
			const model = ctx.model;
			const sessionId = ctx.sessionManager.getSessionId();
			const branch = ctx.sessionManager.getBranch();
			const checkpoint = classifyLatestCheckpoint(branch);
			const mode: RequestMode = isPiSummarizationPayload(event.payload) ? "summarization" : "normal";
			const block = (message: string): never => {
				let identity: NativeIdentity;
				try {
					identity = identityFor(model);
				} catch {
					identity = {
						adapter: isCodexApiModel(model) ? "codex-trigger-sse" : "standard-responses-json",
						provider: model.provider,
						api: model.api,
						model: model.id,
						baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : DEFAULT_CODEX_BASE_URL,
					};
				}
				state.prepareRequest({
					kind: "block",
					mode,
					sessionId,
					leafId: ctx.sessionManager.getLeafId(),
					identity,
					error: message,
				});
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				throw new Error(message);
			};

			if (checkpoint.kind === "malformed") {
				return block("OpenAI native compaction replay failed: the latest native compaction checkpoint is missing or invalid");
			}
			if (!isSupportedServerCompactionModel(model)) {
				if (checkpoint.kind === "native") {
					return block("Native Responses compaction replay failed: the latest checkpoint belongs to a different provider endpoint or model");
				}
				return undefined;
			}

			let replayHistory: ResponseItem[] | undefined;
			try {
				const tools = checkpoint.kind === "native" ? conversionToolCatalog(pi) : [];
				replayHistory = await reconstructReplayHistoryFromCheckpoint(checkpoint, branch, model, tools);
			} catch (error) {
				return block(`OpenAI native compaction replay failed: ${safeDiagnostic(error)}`);
			}
			const identity = identityFor(model);
			state.prepareRequest({
				kind: "send",
				mode,
				sessionId,
				leafId: ctx.sessionManager.getLeafId(),
				identity,
				...(replayHistory ? { replayHistory: cloneJson(replayHistory) } : {}),
				...(mode === "summarization" && isPreparedProviderPayload(event.payload)
					? { originalSummarizerInput: cloneJson(event.payload.input) }
					: {}),
			});
			if (!replayHistory) return undefined;
			const rewritten = mode === "summarization"
				? injectReplayIntoSummarizationPayload(event.payload, replayHistory)
				: rewritePayload(event.payload, replayHistory);
			if (!rewritten) return block("OpenAI native compaction replay failed: the provider payload was malformed");
			// This provisional rewrite keeps hook chaining compatible; the provider decorator is the terminal safety boundary.
			return rewritten;
		});
	};
}

export default createOpenAIServerCompactionExtension();
