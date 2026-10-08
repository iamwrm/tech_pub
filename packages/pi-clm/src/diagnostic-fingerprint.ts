import { createHash } from "node:crypto";

export const MAX_COMPARED_ITEMS = 8192;
const CONFIG_FIELDS = ["model", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "service_tier", "prompt_cache_key", "prompt_cache_retention", "previous_response_id", "store", "stream", "include", "max_tokens", "max_completion_tokens", "max_output_tokens", "context_management", "metadata"] as const;
const ITEM_FIELDS = ["type", "role", "id", "call_id", "name", "arguments", "input", "output", "content", "summary", "encrypted_content", "phase", "status"] as const;
const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const TYPES = new Set(["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "tool_search_call", "tool_search_output", "additional_tools", "compaction", "compaction_trigger"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

export function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface ItemFingerprint {
	hash: string;
	bytes: number;
	type: string;
	role?: string;
	fields: Record<string, string>;
}

export interface PayloadFingerprint {
	payloadHash: string;
	configHash: string;
	configFields: Record<string, string>;
	inputHash: string;
	inputItems: number;
	inputBytes: number;
	reasoningItems: number;
	compactionItems: number;
	comparisonTruncated: boolean;
	items: ItemFingerprint[];
}

function itemFingerprint(value: unknown): ItemFingerprint {
	const item = isRecord(value) ? value : {};
	const fields: Record<string, string> = {};
	for (const key of ITEM_FIELDS) if (key in item) fields[key] = hashJson(item[key]);
	return {
		hash: hashJson(value),
		bytes: Buffer.byteLength(JSON.stringify(value) ?? "undefined"),
		type: typeof item.type === "string" && TYPES.has(item.type) ? item.type : "other",
		...(typeof item.role === "string" && ROLES.has(item.role) ? { role: item.role } : {}),
		fields,
	};
}

/** Only hashes/counts/allowlisted protocol labels leave this function. */
export function fingerprintPayload(payload: unknown): PayloadFingerprint {
	if (!isRecord(payload)) throw new Error("unsupported_payload");
	const input = Array.isArray(payload.input) ? payload.input : Array.isArray(payload.messages) ? payload.messages : [];
	const config: Record<string, unknown> = {};
	const configFields: Record<string, string> = {};
	const other: Record<string, unknown> = {};
	for (const key of CONFIG_FIELDS) if (key in payload) {
		config[key] = payload[key];
		configFields[key] = hashJson(payload[key]);
	}
	for (const key of Object.keys(payload)) if (key !== "input" && key !== "messages" && !(CONFIG_FIELDS as readonly string[]).includes(key)) other[key] = payload[key];
	config.other = other;
	configFields.other = hashJson(other);
	return {
		payloadHash: hashJson(payload),
		configHash: hashJson(config),
		configFields,
		inputHash: hashJson(input),
		inputItems: input.length,
		inputBytes: Buffer.byteLength(JSON.stringify(input)),
		reasoningItems: input.filter((item) => isRecord(item) && item.type === "reasoning").length,
		compactionItems: input.filter((item) => isRecord(item) && item.type === "compaction").length,
		comparisonTruncated: input.length > MAX_COMPARED_ITEMS,
		items: input.slice(0, MAX_COMPARED_ITEMS).map(itemFingerprint),
	};
}

export function comparePayload(previous: PayloadFingerprint | undefined, next: PayloadFingerprint) {
	if (!previous) return { previousAvailable: false as const };
	const changedConfigFields = [...new Set([...Object.keys(previous.configFields), ...Object.keys(next.configFields)])]
		.filter((key) => previous.configFields[key] !== next.configFields[key]);
	let commonInputItems = 0;
	let commonInputBytes = 0;
	while (commonInputItems < Math.min(previous.items.length, next.items.length) && previous.items[commonInputItems].hash === next.items[commonInputItems].hash) {
		commonInputBytes += next.items[commonInputItems].bytes;
		commonInputItems++;
	}
	const before = previous.items[commonInputItems];
	const after = next.items[commonInputItems];
	const itemSummary = (item: ItemFingerprint | undefined) => item ? { hash: item.hash, bytes: item.bytes, type: item.type, role: item.role } : undefined;
	return {
		previousAvailable: true as const,
		previousPayloadHash: previous.payloadHash,
		configChanged: previous.configHash !== next.configHash,
		changedConfigFields,
		commonInputItems,
		commonInputBytes,
		previousInputItems: previous.inputItems,
		previousInputIsPrefix: !previous.comparisonTruncated && commonInputItems === previous.inputItems,
		comparisonTruncated: previous.comparisonTruncated || next.comparisonTruncated,
		...(before || after ? {
			firstDifference: {
				index: commonInputItems,
				before: itemSummary(before),
				after: itemSummary(after),
				changedFields: [...new Set([...Object.keys(before?.fields ?? {}), ...Object.keys(after?.fields ?? {})])]
					.filter((key) => before?.fields[key] !== after?.fields[key]),
			},
		} : {}),
	};
}

export function payloadSummary(value: PayloadFingerprint) {
	const { items: _items, ...summary } = value;
	return summary;
}

/** Never fingerprint auth/cookies or dump arbitrary response/header names. */
export function routingHeaderHashes(headers: Record<string, unknown>): Record<string, string> {
	const allowed = new Set(["chatgpt-account-id", "session-id", "session_id", "x-session-id", "x-client-request-id", "originator", "openai-beta", "x-request-id", "request-id"]);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const name = key.toLowerCase();
		if (allowed.has(name) && (typeof value === "string" || value === null)) result[name] = hashJson(value);
	}
	return result;
}
