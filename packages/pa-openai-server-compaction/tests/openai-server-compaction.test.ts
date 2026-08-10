/**
 * Unit tests for pa-openai-server-compaction pure logic.
 * Run with: node --experimental-strip-types --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCodexCompactionHeaders,
	buildCompactionSupportReport,
	buildCompactionWidgetLines,
	buildPreparedCompactionRequest,
	buildReplacementHistory,
	buildStandardCompactionHeaders,
	buildStandardCompactionRequest,
	createOpenAIServerCompactionExtension,
	extractCodexAccountId,
	extractServerCompactionDetails,
	featureEnabled,
	formatCompactionUsage,
	injectReplayIntoSummarizationPayload,
	isPaSummarizationPayload,
	isSupportedCodexModel,
	isSupportedServerCompactionModel,
	isSupportedStandardResponsesModel,
	parseCompactionSse,
	parseRemoteUsage,
	parseStandardCompactionResponse,
	reconstructReplayHistory,
	retainRecentUserItems,
	rewritePayload,
	safeDiagnostic,
	SERVER_COMPACTION_CHECK_COMMAND,
	formatCompactionSupportReport,
	SERVER_COMPACTION_SHIM_SUMMARY,
	SERVER_COMPACTION_STRATEGY,
	SERVER_COMPACTION_WIDGET_KEY,
} from "../openai-server-compaction.ts";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const codexModel = {
	name: "GPT-5.6 Sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.6-sol",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"] as const,
	contextWindow: 272_000,
	maxTokens: 128_000,
	thinkingLevelMap: { off: "none", medium: "medium", max: "xhigh" },
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
} as unknown as Model<Api>;

const fluxionGpt55 = {
	...codexModel,
	provider: "fluxion-gpt",
	api: "openai-responses",
	id: "gpt-5.5",
	baseUrl: "https://fluxionai.space/v1",
};
const fluxionKimi = { ...fluxionGpt55, provider: "fluxion-cn", id: "kimi-k3" };

function codexToken(accountId = "acct_test") {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }));
	return ["e30", payload.toString("base64url"), "sig"].join(".");
}

function artifact(id = "comp_1") {
	return {
		type: "compaction",
		id,
		encrypted_content: "enc:opaque-ciphertext",
		internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
	};
}

function userItem(text: string, index = 0) {
	return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function completedSse(extra = "") {
	const lines = [
		`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}`,
		`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: artifact() })}`,
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				output: [artifact()],
				usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 60 } },
			},
		})}`,
		"data: [DONE]",
	];
	if (extra) lines.splice(1, 0, extra);
	return lines.join("\n\n") + "\n\n";
}

// ---------------------------------------------------------------------------
// Feature flag / model allowlists
// ---------------------------------------------------------------------------

test("featureEnabled defaults to true and honors explicit opt-outs", () => {
	assert.equal(featureEnabled(undefined), true);
	assert.equal(featureEnabled("1"), true);
	assert.equal(featureEnabled(""), true);
	assert.equal(featureEnabled("0"), false);
	assert.equal(featureEnabled("false"), false);
	assert.equal(featureEnabled("OFF"), false);
	assert.equal(featureEnabled("no"), false);
});

test("allowlist resolution accepts exact Codex and Fluxion tuples and rejects others", () => {
	assert.equal(isSupportedCodexModel(codexModel), true);
	assert.equal(isSupportedCodexModel({ ...codexModel, baseUrl: "https://api.openai.com/v1" }), false);
	assert.equal(isSupportedCodexModel({ ...codexModel, provider: "openai" }), false);
	assert.equal(isSupportedStandardResponsesModel(fluxionGpt55), true);
	assert.equal(isSupportedStandardResponsesModel({ ...fluxionGpt55, id: "gpt-4.1" }), false);
	assert.equal(isSupportedStandardResponsesModel(fluxionKimi), false);
	assert.equal(isSupportedServerCompactionModel(codexModel), true);
	assert.equal(isSupportedServerCompactionModel(fluxionGpt55), true);
	assert.equal(isSupportedServerCompactionModel(fluxionKimi), false);
	assert.equal(isSupportedServerCompactionModel({ provider: "anthropic", api: "anthropic-messages", id: "x" }), false);
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test("Codex compaction headers carry auth, account, feature flag, and the Prime session_id lane", () => {
	const token = codexToken("acct_42");
	const headers = buildCodexCompactionHeaders({ apiKey: token, sessionId: "sess-abc" });
	assert.equal(headers.authorization, `Bearer ${token}`);
	assert.equal(headers["chatgpt-account-id"], "acct_42");
	assert.equal(headers.originator, "pi");
	assert.equal(headers["openai-beta"], "responses=experimental");
	assert.equal(headers["x-codex-beta-features"], "remote_compaction_v2");
	assert.equal(headers["session_id"], "sess-abc");
	assert.equal(headers["x-client-request-id"], "sess-abc");
	assert.equal(headers.accept, "text/event-stream");
	// Body-owned headers must never be forwarded.
	assert.equal(headers["content-length"], undefined);
	assert.equal(headers["transfer-encoding"], undefined);
});

test("Codex compaction headers merge existing beta features without duplicates", () => {
	const token = codexToken();
	// Request headers override model headers for the same key; the remote feature is appended once.
	const headers = buildCodexCompactionHeaders({
		apiKey: token,
		modelHeaders: { "x-codex-beta-features": "responses_websockets=2026-02-06" },
		headers: { "x-codex-beta-features": "some_other_flag" },
		sessionId: "sess-1",
	});
	assert.equal(headers["x-codex-beta-features"], "some_other_flag,remote_compaction_v2");
	// Model-level features survive when no request header overrides them.
	const headers2 = buildCodexCompactionHeaders({
		apiKey: token,
		modelHeaders: { "x-codex-beta-features": "responses_websockets=2026-02-06" },
		sessionId: "sess-1",
	});
	assert.equal(headers2["x-codex-beta-features"], "responses_websockets=2026-02-06,remote_compaction_v2");
});

test("Codex compaction headers delete null-valued model header defaults", () => {
	const token = codexToken();
	const headers = buildCodexCompactionHeaders({
		apiKey: token,
		modelHeaders: { "x-remove-me": "present", "x-null-me": null },
		headers: { "x-remove-me": null, "x-null-me": "present" },
		sessionId: "sess-1",
	});
	assert.equal(headers["x-remove-me"], undefined);
	assert.equal(headers["x-null-me"], "present");
});

test("Standard compaction headers strip Codex-specific headers and use JSON accept", () => {
	const headers = buildStandardCompactionHeaders({ apiKey: "sk-test", headers: { "chatgpt-account-id": "x", "x-codex-beta-features": "y" } });
	assert.equal(headers.authorization, "Bearer sk-test");
	assert.equal(headers.accept, "application/json");
	assert.equal(headers["chatgpt-account-id"], undefined);
	assert.equal(headers["x-codex-beta-features"], undefined);
});

test("extractCodexAccountId parses the chatgpt account claim and rejects bad tokens", () => {
	assert.equal(extractCodexAccountId(codexToken("acct_9")), "acct_9");
	assert.throws(() => extractCodexAccountId("not-a-jwt"));
	assert.throws(() => extractCodexAccountId(codexToken("")));
});

// ---------------------------------------------------------------------------
// Retained user items
// ---------------------------------------------------------------------------

test("retainRecentUserItems keeps the newest real user items within budget", () => {
	const input = [userItem("old message"), userItem("new message")];
	// 11 chars -> 3 tokens each; budget 3 keeps only the newest.
	const retained = retainRecentUserItems(input, 3);
	assert.deepEqual(retained.map((item) => contentOf(item)), ["new message"]);
});

test("retainRecentUserItems truncates an oversized item instead of dropping it", () => {
	const big = userItem("x".repeat(1000));
	const retained = retainRecentUserItems([big], 4);
	assert.equal(retained.length, 1);
	const text = contentOf(retained[0]);
	assert.ok(text.length > 0 && text.length < 1000);
});

test("retainRecentUserItems drops injected context envelopes and remote image URLs", () => {
	const input = [
		userItem("# AGENTS.md instructions\nfoo\n</INSTRUCTIONS>"),
		{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://signed.example/x.png" }] },
		userItem("real user text"),
	];
	const retained = retainRecentUserItems(input, 64);
	assert.deepEqual(retained.map((item) => contentOf(item)), ["real user text"]);
});

type ContentPart = { text?: unknown };
function contentOf(item: { content?: unknown }): string {
	const parts = item.content;
	return Array.isArray(parts)
		? parts.map((part) => (part && typeof part === "object" && "text" in part ? String((part as ContentPart).text ?? "") : "")).join("")
		: String(parts ?? "");
}

test("buildReplacementHistory appends the canonical artifact after retained items", () => {
	const input = [userItem("a"), userItem("b")];
	const history = buildReplacementHistory(input, artifact());
	assert.equal(history.length, 3);
	assert.equal(history[2].type, "compaction");
	assert.equal((history[2] as { encrypted_content?: string }).encrypted_content, "enc:opaque-ciphertext");
	assert.equal((history[2] as { internal_chat_message_metadata_passthrough?: { turn_id?: string } }).internal_chat_message_metadata_passthrough?.turn_id, "turn_1");
});

test("buildReplacementHistory rejects invalid artifacts", () => {
	assert.throws(() => buildReplacementHistory([userItem("a")], { type: "compaction", encrypted_content: "" }));
});

// ---------------------------------------------------------------------------
// SSE / JSON response parsing
// ---------------------------------------------------------------------------

test("parseCompactionSse accepts live framing without a trailing [DONE]", () => {
	const text = completedSse().replace("\n\ndata: [DONE]", "");
	const parsed = parseCompactionSse(text);
	assert.equal(parsed.compactionItem.type, "compaction");
	assert.equal(parsed.responseId, "resp_1");
	assert.equal((parsed.rawUsage as { input_tokens?: number }).input_tokens, 100);
});

test("parseCompactionSse rejects provider error events and classifies overload", () => {
	const text = `event: error\ndata: ${JSON.stringify({ type: "error", code: "server_is_overloaded", message: "busy" })}\n\n`;
	assert.throws(() => parseCompactionSse(text), /failed: busy/);
	try {
		parseCompactionSse(text);
		assert.fail("expected throw");
	} catch (error) {
		const remoteError = error as { name?: string; retryable?: boolean; overload?: boolean };
		assert.equal(remoteError.name, "RemoteCompactionError");
		assert.equal(remoteError.retryable, true);
		assert.equal(remoteError.overload, true);
	}
});

test("parseCompactionSse rejects response.failed events", () => {
	const text = `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { message: "nope" } } })}\n\n`;
	assert.throws(() => parseCompactionSse(text), /nope/);
});

test("parseCompactionSse rejects streams that end before completion", () => {
	const text = `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`;
	assert.throws(() => parseCompactionSse(text), /ended before completion/);
});

test("parseCompactionSse rejects conflicting streamed and completed artifacts", () => {
	const lines = [
		`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: artifact("comp_a") })}`,
		`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [artifact("comp_b")] } })}`,
	];
	assert.throws(() => parseCompactionSse(lines.join("\n\n")), /conflicting/);
});

test("parseStandardCompactionResponse accepts the JSON adapter contract", () => {
	const parsed = parseStandardCompactionResponse(JSON.stringify({
		id: "resp_9",
		status: "completed",
		output: [artifact("comp_9")],
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	}));
	assert.equal(parsed.replacementHistory.length, 1);
	assert.equal(parsed.responseId, "resp_9");
});

test("parseStandardCompactionResponse rejects credential-bearing output", () => {
	const bad = JSON.stringify({
		status: "completed",
		output: [{ ...artifact(), encrypted_content: "enc", extra: "Bearer sk-secret1234567890" }],
	});
	assert.throws(() => parseStandardCompactionResponse(bad), /one final canonical artifact/);
});

test("parseRemoteUsage computes usage and cost from raw provider counters", () => {
	const usage = parseRemoteUsage(codexModel, {
		input_tokens: 100,
		output_tokens: 25,
		total_tokens: 150,
		input_tokens_details: { cached_tokens: 60 },
	});
	assert.ok(usage);
	assert.equal(usage.input, 40);
	assert.equal(usage.cacheRead, 60);
	assert.equal(usage.output, 25);
	assert.equal(usage.totalTokens, 150);
	assert.ok(usage.cost.total > 0);
});

// ---------------------------------------------------------------------------
// Checkpoint details / replay reconstruction
// ---------------------------------------------------------------------------

test("extractServerCompactionDetails round-trips a native checkpoint and rejects tampering", () => {
	const details = {
		strategy: SERVER_COMPACTION_STRATEGY,
		adapter: "codex-trigger-sse",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.com/backend-api",
		replacementHistory: [userItem("recent"), artifact()],
		createdAt: "2026-08-09T00:00:00.000Z",
		responseId: "resp_1",
	};
	const parsed = extractServerCompactionDetails(details);
	assert.ok(parsed);
	assert.equal(parsed.strategy, SERVER_COMPACTION_STRATEGY);
	assert.equal(parsed.replacementHistory.length, 2);
	// Wrong strategy -> rejected.
	assert.equal(extractServerCompactionDetails({ ...details, strategy: "other" }), undefined);
	// Wrong adapter for the endpoint -> rejected.
	assert.equal(extractServerCompactionDetails({ ...details, adapter: "standard-responses-json" }), undefined);
	// Artifact-only history (no retained user items) is valid.
	assert.equal(extractServerCompactionDetails({ ...details, replacementHistory: [artifact()] })?.replacementHistory.length, 1);
	// A trailing non-artifact item is rejected.
	assert.equal(extractServerCompactionDetails({ ...details, replacementHistory: [artifact(), userItem("x")] }), undefined);
});

function branchWithCheckpoint() {
	const checkpointId = "ckpt_1";
	const entries = [
		{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "first", timestamp: 1 } },
		{ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: "reply", timestamp: 2 } },
		{
			type: "compaction",
			id: checkpointId,
			parentId: "m2",
			timestamp: "2026-01-01T00:00:02Z",
			summary: SERVER_COMPACTION_SHIM_SUMMARY,
			firstKeptEntryId: "m2",
			tokensBefore: 1000,
			details: {
				strategy: SERVER_COMPACTION_STRATEGY,
				adapter: "codex-trigger-sse",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: "gpt-5.6-sol",
				baseUrl: "https://chatgpt.com/backend-api",
				replacementHistory: [userItem("kept user"), artifact()],
				createdAt: "2026-01-01T00:00:02Z",
			},
		},
		{ type: "message", id: "m3", parentId: checkpointId, timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: "tail", timestamp: 3 } },
	];
	return { entries: entries as unknown as SessionEntry[], checkpointId };
}

test("reconstructReplayHistory replays checkpoint history plus the converted branch tail", async () => {
	const { entries } = branchWithCheckpoint();
	const replay = await reconstructReplayHistory(entries, codexModel);
	assert.ok(replay);
	assert.ok(replay.some((item) => item.type === "compaction"));
	// The tail user message must be present as a converted Responses item.
	assert.ok(replay.some((item) => JSON.stringify(item).includes("tail")));
	// Items before the checkpoint are not part of the replay.
	assert.ok(!JSON.stringify(replay).includes("first"));
});

test("reconstructReplayHistory returns undefined without a native checkpoint", async () => {
	const entries = [
		{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "x", timestamp: 1 } },
	] as unknown as SessionEntry[];
	const replay = await reconstructReplayHistory(entries, codexModel);
	assert.equal(replay, undefined);
});

test("reconstructReplayHistory allows model changes within the same Codex endpoint lane", async () => {
	// Codex checkpoints replay across qualified Codex models on the same endpoint.
	const { entries } = branchWithCheckpoint();
	const replay = await reconstructReplayHistory(entries, { ...codexModel, id: "gpt-5.5" });
	assert.ok(replay);
});

test("reconstructReplayHistory rejects a checkpoint for a different endpoint", async () => {
	const { entries } = branchWithCheckpoint();
	await assert.rejects(
		() => reconstructReplayHistory(entries, { ...codexModel, baseUrl: "https://api.openai.com/v1" }),
		/does not use a supported Responses compaction endpoint|different provider endpoint or model/,
	);
});

test("reconstructReplayHistory rejects malformed checkpoints", async () => {
	const { entries } = branchWithCheckpoint();
	const broken = entries.map((entry) => entry.type === "compaction"
		? { ...entry, details: { ...(entry as { details?: unknown }).details as object, replacementHistory: [{ type: "message", role: "user", content: [{ type: "input_text" }] }] } }
		: entry) as unknown as SessionEntry[];
	await assert.rejects(() => reconstructReplayHistory(broken, codexModel), /missing or invalid/);
});

// ---------------------------------------------------------------------------
// Payload building / rewriting
// ---------------------------------------------------------------------------

test("buildPreparedCompactionRequest appends a compaction_trigger and drops previous_response_id", () => {
	const prepared = { model: "gpt-5.6-sol", input: [userItem("a")], previous_response_id: "resp_x", store: false };
	const { body, compactedInput } = buildPreparedCompactionRequest(prepared, [userItem("tail")]);
	assert.equal(((body.input as unknown[]).at(-1) as { type?: string } | undefined)?.type, "compaction_trigger");
	assert.equal(body.previous_response_id, undefined);
	assert.equal(compactedInput.length, 2);
});

test("buildStandardCompactionRequest projects only model/input/instructions/prompt_cache_key", () => {
	const prepared = {
		model: "gpt-5.5",
		input: [userItem("a")],
		instructions: "sys",
		prompt_cache_key: "k",
		store: false,
		stream: true,
		tools: [],
	};
	const { body, compactedInput } = buildStandardCompactionRequest(prepared, [userItem("tail")]);
	assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "prompt_cache_key"]);
	assert.equal((body.input as unknown[]).length, 2);
	assert.equal(compactedInput.length, 2);
});

test("rewritePayload replaces input with the replay history and drops stale fields", () => {
	const rewritten = rewritePayload({ model: "gpt-5.6-sol", input: [userItem("old")], previous_response_id: "r" }, [artifact()]);
	assert.ok(rewritten);
	const input = rewritten.input as unknown[];
	assert.equal(input.length, 1);
	assert.equal((input[0] as { type?: string }).type, "compaction");
	assert.equal(rewritten.previous_response_id, undefined);
});

test("isPaSummarizationPayload detects Prime Agent compaction and branch summarizer envelopes", () => {
	const sys = "You are a context summarization assistant. ONLY output the structured summary.";
	const payload = {
		instructions: sys,
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<conversation>\nstuff\n</conversation>\n\n## Goal\n## Progress\n## Critical Context" }] },
		],
	};
	assert.equal(isPaSummarizationPayload(payload), true);
	assert.equal(isPaSummarizationPayload({ instructions: sys, input: [] }), false);
	assert.equal(isPaSummarizationPayload({ instructions: "normal", input: [] }), false);
});

test("injectReplayIntoSummarizationPayload inserts replay after system/developer items once", () => {
	const payload = {
		instructions: "sys",
		input: [
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<conversation>\n</conversation>\n## Goal" }] },
		],
	};
	const replay = [userItem("kept"), artifact()];
	const rewritten = injectReplayIntoSummarizationPayload(payload, replay);
	assert.ok(rewritten);
	const rewrittenInput = rewritten.input as unknown[];
	assert.equal(rewrittenInput.length, 4);
	assert.deepEqual(rewrittenInput[1], replay[0]);
	assert.equal((rewrittenInput[2] as { type?: string }).type, "compaction");
});


// ---------------------------------------------------------------------------
// Extension factory registration surface
// ---------------------------------------------------------------------------

test("extension factory registers provider decorators and lifecycle hooks", () => {
	const registered: Array<{ name: string; api: unknown; hasStreamSimple: boolean }> = [];
	const hooks = new Set<string>();
	const fakePi = {
		registerProvider(name: string, config: { api?: unknown; streamSimple?: unknown }) {
			registered.push({ name, api: config.api, hasStreamSimple: typeof config.streamSimple === "function" });
		},
		registerCommand() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			hooks.add(event);
			assert.equal(typeof handler, "function");
		},
		getAllTools() {
			return [];
		},
	};
	const extension = createOpenAIServerCompactionExtension({ fetchFn: (async () => new Response("", { status: 500 })) });
	extension(fakePi as unknown as Parameters<typeof extension>[0]);
	assert.deepEqual(
		registered.map((entry) => entry.name).sort(),
		["fluxion-gpt", "fluxion-grok", "openai-codex"].sort(),
	);
	assert.ok(registered.every((entry) => entry.hasStreamSimple));
	for (const event of ["session_start", "session_tree", "model_select", "session_shutdown", "session_before_compact", "session_compact", "before_provider_request"]) {
		assert.ok(hooks.has(event), `missing hook ${event}`);
	}
});


// ---------------------------------------------------------------------------
// before_provider_request arming-failure behavior
// ---------------------------------------------------------------------------

function capturedBeforeProviderRequestHandler() {
	const hooks = new Map<string, (...args: any[]) => unknown>();
	const fakePi = {
		registerProvider() {},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			hooks.set(event, handler);
		},
		getAllTools() {
			return [];
		},
	};
	const extension = createOpenAIServerCompactionExtension({
		fetchFn: (async () => new Response("", { status: 500 })) as any,
	});
	extension(fakePi as any);
	const handler = hooks.get("before_provider_request") as
		| ((event: any, ctx: any) => Promise<unknown>)
		| undefined;
	if (!handler) throw new Error("before_provider_request handler was not registered");
	return handler;
}

test("before_provider_request passes through when arming fails without a native checkpoint", async () => {
	const handler = capturedBeforeProviderRequestHandler();
	const ctx = {
		hasUI: false,
		model: codexModel,
		sessionManager: {
			getSessionId: () => "sess-arm",
			getLeafId: () => "leaf-arm",
			getBranch: () => [] as unknown as SessionEntry[],
		},
	};
	// No native checkpoint and no active decorated-stream scope (arming fails):
	// the request must pass through untouched instead of returning the circular
	// backstop payload that bricks every retry of the request.
	const result = await handler({ payload: { model: "gpt-5.6-sol", input: [userItem("x")] } }, ctx);
	assert.equal(result, undefined);
});

test("before_provider_request blocks serialization with a clear message when arming fails with a native checkpoint", async () => {
	const handler = capturedBeforeProviderRequestHandler();
	const ctx = {
		hasUI: false,
		model: codexModel,
		sessionManager: {
			getSessionId: () => "sess-arm",
			getLeafId: () => "leaf-arm",
			getBranch: () => branchWithCheckpoint().entries,
		},
	};
	// A native checkpoint exists but the plan cannot be armed: replay must not
	// be silently skipped, so the blocking payload is returned and provider
	// serialization fails locally (the intended hard-block signal). The
	// blocking payload must fail with a clear, actionable message instead of
	// the old "Converting circular structure to JSON" backstop that bricked
	// every retry of the request and the whole session until reload.
	const result = await handler({ payload: { model: "gpt-5.6-sol", input: [userItem("x")] } }, ctx);
	assert.ok(result && typeof result === "object");
	assert.throws(
		() => JSON.stringify(result),
		(error) => error instanceof Error
			&& error.message.includes("OpenAI native compaction replay is unavailable")
			&& error.message.includes("next request re-registers the decorator automatically"),
	);
});

test("before_provider_request re-registers the decorated provider after a registry reset", async () => {
	const calls: Array<{ name: string; api: unknown; hasStreamSimple: boolean }> = [];
	const hooks = new Map<string, (...args: any[]) => unknown>();
	const fakePi = {
		registerProvider(name: string, config: { api?: unknown; streamSimple?: unknown }) {
			calls.push({ name, api: config.api, hasStreamSimple: typeof config.streamSimple === "function" });
		},
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			hooks.set(event, handler);
		},
		getAllTools() {
			return [];
		},
	};
	const extension = createOpenAIServerCompactionExtension({
		fetchFn: (async () => new Response("", { status: 500 })) as any,
	});
	extension(fakePi as any);
	const initial = calls.filter((call) => call.name === "openai-codex").length;
	assert.ok(initial >= 1, "extension must register the codex provider at load");

	const handler = hooks.get("before_provider_request") as
		| ((event: any, ctx: any) => Promise<unknown>)
		| undefined;
	if (!handler) throw new Error("before_provider_request handler was not registered");
	const ctx = {
		hasUI: false,
		model: codexModel,
		sessionManager: {
			getSessionId: () => "sess-reassert",
			getLeafId: () => "leaf-reassert",
			getBranch: () => branchWithCheckpoint().entries,
		},
	};
	// Simulate another session's ModelRegistry.refresh() wiping the shared
	// provider registry, then verify the next hook invocation re-asserts the
	// decorated registration so the following request self-heals.
	await handler({ payload: { model: "gpt-5.6-sol", input: [userItem("x")] } }, ctx);
	const after = calls.filter((call) => call.name === "openai-codex").length;
	assert.ok(after > initial, "hook must re-register the codex provider");
	const last = calls.filter((call) => call.name === "openai-codex").at(-1);
	assert.equal(last?.api, "openai-codex-responses");
	assert.equal(last?.hasStreamSimple, true);
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("safeDiagnostic redacts bearer tokens, JWTs, and API keys", () => {
	const raw = "error Bearer sk-secret1234567890 and eyJhbGciOiJub25lIn0.eyJhY2NvdW50IjoieCJ9.sig";
	const out = safeDiagnostic(raw);
	assert.ok(!out.includes("sk-secret1234567890"));
	assert.ok(!out.includes("eyJhbGciOiJub25lIn0"));
	assert.ok(out.includes("Bearer <redacted>"));
});

test("formatCompactionUsage renders cache ratio", () => {
	const usage = { input: 40, output: 25, cacheRead: 60, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const text = formatCompactionUsage(usage);
	assert.ok(text);
	assert.match(text, /input 100/);
	assert.match(text, /cache read 60 \(60\.0%\)/);
	assert.equal(formatCompactionUsage(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Persistent widget (scheme 1: above-editor native-compaction status)
// ---------------------------------------------------------------------------

function nativeDetails(usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } | null) {
	return {
		strategy: SERVER_COMPACTION_STRATEGY,
		adapter: "codex-trigger-sse",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		baseUrl: "https://chatgpt.com/backend-api",
		replacementHistory: [userItem("kept"), artifact()],
		createdAt: "2026-08-09T00:00:00.000Z",
		...(usage ? { usage } : {}),
	} as import("../openai-server-compaction.ts").ServerCompactionDetails;
}

test("buildCompactionWidgetLines shows native status, usage, and the operational warning", () => {
	const lines = buildCompactionWidgetLines(nativeDetails({ input: 40, output: 25, cacheRead: 60, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }));
	assert.equal(lines[0], "⚡ Native Responses compaction active");
	assert.ok(lines.some((line) => line.includes("Compaction V2 · input 100")), lines.join("|"));
	assert.ok(lines.some((line) => line.includes("Do not switch providers or disable compaction mid-session")), lines.join("|"));
	assert.ok(lines.some((line) => line.includes("opaque checkpoint")), lines.join("|"));
});

test("buildCompactionWidgetLines works without usage details and with undefined", () => {
	assert.equal(buildCompactionWidgetLines(nativeDetails(null)).length, 3);
	assert.equal(buildCompactionWidgetLines(undefined).length, 3);
	assert.ok(buildCompactionWidgetLines(undefined)[0].includes("Native Responses compaction active"));
});

test("session_compact handler shows the widget for native compaction and clears it on readable fallback", () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const widgetCalls: Array<{ content?: string[] }> = [];
	const fakePi = {
		registerProvider(_name: string, _config: { api?: unknown; streamSimple?: unknown }) {},
		registerCommand() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		getAllTools() {
			return [];
		},
	};
	const extension = createOpenAIServerCompactionExtension({ fetchFn: (async () => new Response("", { status: 500 })) });
	extension(fakePi as never);

	const ui = {
		setWidget: (key: string, content: string[] | undefined) => {
			assert.equal(key, SERVER_COMPACTION_WIDGET_KEY);
			widgetCalls.push({ content });
		},
		setStatus: () => {},
		notify: () => {},
	};
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionId: () => "sess-widget" },
		ui,
	};

	// Native success: widget appears.
	const compactHandler = handlers.get("session_compact");
	assert.ok(compactHandler);
	compactHandler({ type: "session_compact", fromExtension: true, compactionEntry: { details: nativeDetails({ input: 40, output: 25, cacheRead: 60, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }) } }, ctx as never);
	assert.equal(widgetCalls.at(-1)?.content?.length, 4);
	assert.ok(widgetCalls.at(-1)?.content?.[0].includes("Native Responses compaction active"));

	// Readable fallback: widget is cleared.
	compactHandler({ type: "session_compact", fromExtension: false, compactionEntry: { details: {} } }, ctx as never);
	assert.equal(widgetCalls.at(-1)?.content, undefined);

	// Session reset clears the widget too.
	const startHandler = handlers.get("session_start");
	assert.ok(startHandler);
	startHandler({ type: "session_start" }, ctx as never);
	assert.equal(widgetCalls.at(-1)?.content, undefined);
});

// ---------------------------------------------------------------------------
// /server-compaction-check command (dry-run support probe)
// ---------------------------------------------------------------------------

test("buildCompactionSupportReport classifies a supported codex model", () => {
	const report = buildCompactionSupportReport({
		featureEnabled: true,
		model: codexModel,
		checkpoint: { kind: "none" },
		snapshotAvailable: true,
		authOk: true,
	});
	assert.equal(report.supported, true);
	assert.equal(report.adapter, "codex-trigger-sse");
	assert.equal(report.endpoint, "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(report.model, "openai-codex/gpt-5.6-sol");
	assert.equal(report.checkpoint, "none");
});

test("buildCompactionSupportReport rejects unsupported models and disabled feature", () => {
	const unsupported = buildCompactionSupportReport({
		featureEnabled: true,
		model: { ...codexModel, provider: "anthropic", api: "anthropic-messages", id: "claude-x" },
		checkpoint: { kind: "plain" },
		snapshotAvailable: false,
		authOk: false,
		authError: "no key",
	});
	assert.equal(unsupported.supported, false);
	assert.equal(unsupported.adapter, undefined);
	const disabled = buildCompactionSupportReport({
		featureEnabled: false,
		model: codexModel,
		checkpoint: { kind: "native", index: 1, details: nativeDetails(null) },
		snapshotAvailable: true,
		authOk: true,
	});
	assert.equal(disabled.featureEnabled, false);
	assert.equal(disabled.checkpoint, "native");
});

test("formatCompactionSupportReport renders a complete report including live results", () => {
	const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const report = buildCompactionSupportReport({
		featureEnabled: true,
		model: codexModel,
		checkpoint: { kind: "native", index: 2, details: nativeDetails(usage) },
		snapshotAvailable: true,
		authOk: true,
		live: { ok: true, artifactId: "cmp_dry_1", usage },
	});
	const lines = formatCompactionSupportReport(report);
	const text = lines.join("\n");
	assert.ok(text.includes("supported:    YES"));
	assert.ok(text.includes("codex-trigger-sse"));
	assert.ok(text.includes("checkpoint:   native checkpoint active"));
	assert.ok(text.includes("live dry-run: OK · artifact cmp_dry_1"));
	assert.ok(lines.length <= 10);
});

test("extension registers the check command and its static path reports results", async () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notifications: string[] = [];
	const widgetCalls: Array<{ key: string; content?: string[] }> = [];
	const fakePi = {
		registerProvider(_name: string, _config: { api?: unknown; streamSimple?: unknown }) {},
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		getAllTools() {
			return [];
		},
	};
	const extension = createOpenAIServerCompactionExtension({ fetchFn: (async () => new Response("", { status: 500 })) });
	extension(fakePi as never);

	assert.ok(commands.has(SERVER_COMPACTION_CHECK_COMMAND));
	const command = commands.get(SERVER_COMPACTION_CHECK_COMMAND);

	const ctx = {
		hasUI: true,
		model: codexModel,
		sessionManager: {
			getSessionId: () => "sess-check",
			getBranch: () => [],
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "sk-test", headers: {} }),
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push(`${type ?? "info"}: ${message}`),
			setWidget: (key: string, content?: string[]) => widgetCalls.push({ key, content }),
			setStatus: () => {},
		},
	};
	assert.ok(command);
	await command.handler("", ctx as never);
	// Static path: SUPPORTED + a full report widget was shown.
	assert.ok(notifications.some((n) => n.includes("SUPPORTED")));
	assert.ok(widgetCalls.some((w) => w.key.endsWith("-check") && w.content?.some((l) => l.includes("supported:    YES"))));
});

test("command live dry run drives a real compaction request through the injected fetch", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const capturedBodies: string[] = [];
	const liveSse = [
		`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_dry", status: "in_progress" } })}`,
		`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: artifact("cmp_dry_live") })}`,
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_dry", status: "completed", output: [artifact("cmp_dry_live")], usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 } },
		})}`,
		"data: [DONE]",
	].join("\n\n") + "\n\n";
	const fetchFn = async (url: unknown, init: { body?: string }) => {
		capturedBodies.push(String(init.body ?? ""));
		return new Response(liveSse, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const fakePi = {
		registerProvider() {},
		registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(_name, options);
		},
		on() {},
		getAllTools() {
			return [];
		},
	};
	const extension = createOpenAIServerCompactionExtension({ fetchFn: fetchFn as never, sleepFn: async () => {} });
	extension(fakePi as never);
	const command = commands.get(SERVER_COMPACTION_CHECK_COMMAND);

	const notifications: string[] = [];
	const ctx = {
		hasUI: true,
		model: codexModel,
		sessionManager: { getSessionId: () => "sess-live", getBranch: () => [] },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: codexToken(), headers: {} }),
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setWidget: () => {},
			setStatus: () => {},
		},
	};
	assert.ok(command);
	await command.handler("live", ctx as never);
	// The probe body must end with the compaction trigger.
	const body = JSON.parse(capturedBodies[0]) as { input?: Array<{ type?: string }> };
	assert.equal((body.input ?? []).at(-1)?.type, "compaction_trigger");
	assert.ok(notifications.some((n) => n.includes("live dry-run OK")));
});
