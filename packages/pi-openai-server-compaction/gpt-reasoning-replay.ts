/**
 * Vendored pure GPT reasoning replay projection for native compaction tails.
 *
 * Copied from `packages/ren-public-package/0021-gpt-reasoning-replay.ts`
 * (ren-public-package 0.10.6) when `0017-openai-server-compaction` was promoted
 * to this standalone package (pi-openai-server-compaction 0.1.0). The
 * ren-public-package copy is the authoritative implementation; the replay
 * semantics are owned by [IV-0008](../../docs/IV-DC/IV-0008-preserve-opaque-reasoning-across-gpt-model-switches.md).
 * Keep this file behavior-identical: when the authoritative copy changes,
 * update this vendored copy and this header.
 *
 * Only the pure projection is vendored. The default `context`-event factory
 * stays in ren-public-package and is not needed here; this file must not
 * register any runtime behavior.
 */
import type { Api, AssistantMessage, Model, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export const GPT_REASONING_REPLAY_ENV = "PI_GPT_REASONING_REPLAY";
export const MAX_REASONING_SIGNATURE_CHARS = 8 * 1024 * 1024;
export const MAX_REASONING_TEXT_CHARS = 1024 * 1024;
export const MAX_REASONING_TEXT_PARTS = 1024;

type ModelIdentity = Pick<Model<Api>, "provider" | "api" | "id">;
type RoleMessage = { role: string };
type ToolResultLike = RoleMessage & { role: "toolResult"; toolCallId: string };
type JsonObject = Record<string, unknown>;
type CanonicalReasoningText = { type: "summary_text" | "reasoning_text"; text: string };
type ReplayableReasoningEnvelope = { canonicalSignatures: string[]; outputStart: number };
type CachedReasoningSignature = { source: unknown; canonical: string | undefined };

// Session messages retain block object identity across context builds. A weak
// cache avoids reparsing the same opaque string on every tool-loop request while
// retaining neither the block nor ciphertext after Pi releases the message.
const reasoningSignatureCache = new WeakMap<ThinkingContent, CachedReasoningSignature>();

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function featureEnabled(value: string | undefined): boolean {
	if (typeof value !== "string") return true;
	return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** Model IDs are the compatibility contract; providers and Responses endpoints may differ. */
export function isGptModelId(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().includes("gpt");
}

function canonicalizeReasoningText(
	value: unknown,
	type: CanonicalReasoningText["type"],
): CanonicalReasoningText[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_REASONING_TEXT_PARTS) return undefined;
	let characters = 0;
	const canonical: CanonicalReasoningText[] = [];
	for (const part of value) {
		if (!isRecord(part) || part.type !== type || typeof part.text !== "string") return undefined;
		characters += part.text.length;
		if (characters > MAX_REASONING_TEXT_CHARS) return undefined;
		canonical.push({ type, text: part.text });
	}
	return canonical;
}

/**
 * Validate and canonicalize the stable Responses reasoning schema. Unknown
 * imported/vendor fields are not forwarded; the opaque ciphertext is exact.
 */
export function canonicalizeOpaqueResponsesReasoningSignature(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REASONING_SIGNATURE_CHARS) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (
			!isRecord(parsed)
			|| parsed.type !== "reasoning"
			|| typeof parsed.id !== "string"
			|| parsed.id.trim().length === 0
			|| typeof parsed.encrypted_content !== "string"
			|| parsed.encrypted_content.trim().length === 0
			|| (parsed.status !== undefined && parsed.status !== "completed")
		) return undefined;
		const summary = canonicalizeReasoningText(parsed.summary, "summary_text");
		if (!summary) return undefined;
		const content = parsed.content === undefined
			? undefined
			: canonicalizeReasoningText(parsed.content, "reasoning_text");
		if (parsed.content !== undefined && !content) return undefined;
		return JSON.stringify({
			type: "reasoning",
			id: parsed.id,
			summary,
			encrypted_content: parsed.encrypted_content,
			...(content ? { content } : {}),
			...(parsed.status === "completed" ? { status: "completed" } : {}),
		});
	} catch {
		return undefined;
	}
}

export function isOpaqueResponsesReasoningSignature(value: unknown): value is string {
	return canonicalizeOpaqueResponsesReasoningSignature(value) !== undefined;
}

function canonicalizeThinkingBlockSignature(block: ThinkingContent): string | undefined {
	const source = block.thinkingSignature;
	const cached = reasoningSignatureCache.get(block);
	if (cached && cached.source === source) return cached.canonical;
	const canonical = canonicalizeOpaqueResponsesReasoningSignature(source);
	reasoningSignatureCache.set(block, { source, canonical });
	return canonical;
}

function sameIdentity(message: AssistantMessage, target: ModelIdentity): boolean {
	return message.provider === target.provider
		&& message.api === target.api
		&& message.model === target.id;
}

function getReplayableReasoningEnvelope(message: AssistantMessage): ReplayableReasoningEnvelope | undefined {
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return undefined;
	if (!Array.isArray(message.content)) return undefined;
	const canonicalSignatures: string[] = [];
	let index = 0;
	while (index < message.content.length && message.content[index]?.type === "thinking") {
		const block = message.content[index] as ThinkingContent;
		const canonical = block.redacted
			? undefined
			: canonicalizeThinkingBlockSignature(block);
		if (!canonical) return undefined;
		canonicalSignatures.push(canonical);
		index++;
	}
	if (index === 0 || index === message.content.length) return undefined;
	let hasOutput = false;
	for (let outputIndex = index; outputIndex < message.content.length; outputIndex++) {
		const block = message.content[outputIndex];
		if (!isRecord(block) || block.type === "thinking") return undefined;
		if (block.type === "text") {
			if (typeof block.text !== "string") return undefined;
			if (block.text.length > 0) hasOutput = true;
			continue;
		}
		if (block.type === "toolCall") {
			if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments)) {
				return undefined;
			}
			hasOutput = true;
			continue;
		}
		return undefined;
	}
	return hasOutput ? { canonicalSignatures, outputStart: index } : undefined;
}

function sanitizeToolCallForGptSwitch(block: ToolCall): { block: ToolCall; originalId: string; replayId: string } | undefined {
	const [callId] = block.id.split("|");
	if (!callId || callId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(callId)) return undefined;
	const replay: ToolCall = { ...block, id: callId };
	delete replay.thoughtSignature;
	return { block: replay, originalId: block.id, replayId: callId };
}

/**
 * Project GPT-origin Responses history onto a different GPT identity without
 * mutating persisted messages. Retagging retains available text signatures;
 * provider-specific tool item IDs/signatures are removed explicitly.
 */
export function prepareGptReasoningReplay<TMessage extends RoleMessage>(
	messages: TMessage[],
	target: ModelIdentity,
): TMessage[] {
	if (!isGptModelId(target.id)) return messages;

	let projected: TMessage[] | undefined;
	let toolCallIds: Map<string, string> | undefined;
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		let nextMessage = message;

		if (message.role === "toolResult") {
			const toolResult = message as unknown as ToolResultLike;
			const replayId = toolCallIds?.get(toolResult.toolCallId);
			if (replayId !== undefined && replayId !== toolResult.toolCallId) {
				nextMessage = { ...message, toolCallId: replayId } as TMessage;
			}
		} else {
			// Tool results pair only with the immediately preceding assistant tool turn.
			toolCallIds = undefined;
			if (message.role === "assistant") {
				const assistant = message as unknown as AssistantMessage;
				const envelope = !isGptModelId(assistant.model) || sameIdentity(assistant, target)
					? undefined
					: getReplayableReasoningEnvelope(assistant);
				if (envelope) {
					const content: AssistantMessage["content"] = [];
					const nextToolCallIds: Array<readonly [string, string]> = [];
					const replayToolCallIds = new Set<string>();
					let valid = true;
					for (let blockIndex = 0; blockIndex < assistant.content.length; blockIndex++) {
						const block = assistant.content[blockIndex];
						if (block.type === "thinking" && blockIndex < envelope.outputStart) {
							content.push({ ...block, thinkingSignature: envelope.canonicalSignatures[blockIndex] });
							continue;
						}
						if (block.type !== "toolCall") {
							content.push(block);
							continue;
						}
						const sanitized = sanitizeToolCallForGptSwitch(block);
						if (!sanitized || replayToolCallIds.has(sanitized.replayId)) {
							valid = false;
							break;
						}
						replayToolCallIds.add(sanitized.replayId);
						content.push(sanitized.block);
						nextToolCallIds.push([sanitized.originalId, sanitized.replayId]);
					}
					if (valid) {
						if (nextToolCallIds.length > 0) toolCallIds = new Map(nextToolCallIds);
						nextMessage = {
							...assistant,
							provider: target.provider,
							api: target.api,
							model: target.id,
							content,
						} as unknown as TMessage;
					}
				}
			}
		}

		if (nextMessage !== message && !projected) projected = messages.slice(0, messageIndex);
		projected?.push(nextMessage);
	}

	return projected ?? messages;
}
