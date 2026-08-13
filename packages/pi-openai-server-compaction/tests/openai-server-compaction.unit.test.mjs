import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const require = createRequire(import.meta.url);
const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const { createJiti } = require(
	require.resolve("jiti", {
		paths: [path.join(pkgDir, "node_modules/@earendil-works/pi-coding-agent")],
	}),
);
const jiti = createJiti(import.meta.url);
const serverCompaction = await jiti.import(path.join(pkgDir, "openai-server-compaction.ts"));
const { GPT_REASONING_REPLAY_ENV } = await jiti.import(path.join(pkgDir, "gpt-reasoning-replay.ts"));
const {
	MAX_REPLACEMENT_HISTORY_BYTES,
	MAX_RESPONSE_BYTES,
	REMOTE_COMPACTION_MAX_ATTEMPTS,
	REMOTE_COMPACTION_OVERLOAD_RETRY_BASE_DELAY_MS,
	REMOTE_COMPACTION_RETRY_BASE_DELAY_MS,
	RETAINED_USER_TOKEN_BUDGET,
	SERVER_COMPACTION_DISPLAY_ENTRY_TYPE,
	SERVER_COMPACTION_DISPLAY_TEXT,
	SERVER_COMPACTION_ENV,
	SERVER_COMPACTION_FALLBACK_ENTRY_TYPE,
	SERVER_COMPACTION_FALLBACK_TEXT,
	SERVER_COMPACTION_SHIM_SUMMARY,
	SERVER_COMPACTION_STRATEGY,
	buildCodexCompactionHeaders,
	buildCompactionRequestFromSnapshot,
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
	isPiSummarizationPayload,
	isSupportedCodexModel,
	isSupportedServerCompactionModel,
	isSupportedStandardResponsesModel,
	parseCompactionSse,
	parseStandardCompactionResponse,
	parseRemoteUsage,
	reconstructReplayHistory,
	resolveFinalProviderPayload,
	retainRecentUserItems,
	rewritePayload,
	safeDiagnostic,
} = serverCompaction;

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-test",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	thinkingLevelMap: { off: "none", medium: "medium", max: "xhigh" },
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
};

const fluxionGpt55 = {
	...model,
	provider: "fluxion-gpt",
	api: "openai-responses",
	id: "gpt-5.5",
	baseUrl: "https://fluxionai.space/v1",
};
const fluxionGpt56 = { ...fluxionGpt55, id: "gpt-5.6-sol" };
const fluxionGrok = {
	...fluxionGpt55,
	provider: "fluxion-grok",
	id: "grok-4.5",
	contextWindow: 500_000,
};
const fluxionGrok46 = { ...fluxionGrok, id: "grok-4.6" };
const xaiGrok46 = {
	...fluxionGpt55,
	provider: "xai",
	id: "grok-4.6",
	baseUrl: "https://api.x.ai/v1",
	contextWindow: 500_000,
};
const fluxionKimi = {
	...fluxionGpt55,
	provider: "fluxion-cn",
	id: "kimi-k3",
	contextWindow: 1_000_000,
};

const SUMMARIZATION_SYSTEM_PROMPT = [
	"You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant,",
	"then produce a structured summary following the exact format specified.",
	"Do NOT continue the conversation. ONLY output the structured summary.",
].join(" ");

function summaryPrompt(conversation = "[User]: hello") {
	return `<conversation>\n${conversation}\n</conversation>\n\nUse this EXACT format:\n\n## Goal\n...\n## Progress\n...\n## Critical Context\n...`;
}

function summaryProviderContext(conversation) {
	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt(conversation) }], timestamp: 1 }],
		tools: [],
	};
}

function token(accountId = "acct-test") {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function sse(events, { done = true, namedEvents = false } = {}) {
	const body = events.map((event) => {
		const data = `data: ${JSON.stringify(event)}\n\n`;
		if (!namedEvents || typeof event?.type !== "string") return data;
		return `event: ${event.type}\n${data}`;
	}).join("");
	return done ? `${body}data: [DONE]\n\n` : body;
}

function normalResponse(text = "ACK") {
	return new Response(
		sse([
			{ type: "response.created", response: { id: "resp-normal" } },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					id: "msg-normal",
					type: "message",
					status: "completed",
					role: "assistant",
					phase: "final_answer",
					content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp-normal",
					status: "completed",
					usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
				},
			},
		]),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function compactionResponse({ encrypted = "opaque", inputTokens = 100, outputTokens = 20, cacheRead = 30 } = {}) {
	return new Response(
		sse([
			{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: encrypted } },
			{
				type: "response.completed",
				response: {
					id: `resp-${encrypted}`,
					usage: {
						input_tokens: inputTokens,
						output_tokens: outputTokens,
						total_tokens: inputTokens + outputTokens,
						input_tokens_details: { cached_tokens: cacheRead },
					},
				},
			},
		]),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function standardCompactionOutput({ encrypted = "opaque-standard", type = "compaction_summary", withMessage = true } = {}) {
	return [
		...(withMessage
			? [{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "canonical retained message" }],
				vendor_extension: { preserved: true },
			}]
			: []),
		{
			type,
			id: `cmp-${encrypted}`,
			encrypted_content: encrypted,
			created_by: "mirror",
			vendor_extension: { preserved: true },
		},
	];
}

function standardCompactionResponse(options = {}) {
	const output = options.output ?? standardCompactionOutput(options);
	return new Response(JSON.stringify({
		id: options.id ?? "resp-standard",
		object: "response.compaction",
		output,
		usage: options.usage ?? {
			input_tokens: 100,
			output_tokens: 20,
			total_tokens: 120,
			input_tokens_details: { cached_tokens: 30 },
		},
	}), { status: options.status ?? 200, headers: { "content-type": "application/json" } });
}

function usage({ input = 10, output = 4, cacheRead = 2, cacheWrite = 1, totalTokens = 17 } = {}) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: input / 100,
			output: output / 100,
			cacheRead: cacheRead / 100,
			cacheWrite: cacheWrite / 100,
			total: (input + output + cacheRead + cacheWrite) / 100,
		},
	};
}

function entry(id, parentId, message) {
	return { type: "message", id, parentId, timestamp: "2026-07-30T00:00:00.000Z", message };
}

function compactionEntry(id, parentId, details, summary = SERVER_COMPACTION_SHIM_SUMMARY) {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2026-07-30T00:00:00.000Z",
		summary,
		firstKeptEntryId: parentId,
		tokensBefore: 50_000,
		details,
	};
}

function userEntry(id = "u1", parentId = null, text = "hello") {
	return entry(id, parentId, { role: "user", content: [{ type: "text", text }], timestamp: 1 });
}

function assistantEntry(id, parentId, text = "ACK", overrides = {}) {
	return entry(id, parentId, {
		role: "assistant",
		provider: model.provider,
		api: model.api,
		model: model.id,
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: usage(),
		timestamp: 2,
		...overrides,
	});
}

function nativeDetails(overrides = {}) {
	return {
		strategy: SERVER_COMPACTION_STRATEGY,
		adapter: "codex-trigger-sse",
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: model.baseUrl,
		replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
		createdAt: "2026-07-30T00:00:00.000Z",
		...overrides,
	};
}

function standardNativeDetails(activeModel = fluxionGpt55, overrides = {}) {
	return nativeDetails({
		adapter: "standard-responses-json",
		provider: activeModel.provider,
		api: activeModel.api,
		model: activeModel.id,
		baseUrl: activeModel.baseUrl,
		replacementHistory: standardCompactionOutput(),
		...overrides,
	});
}

function withFeatureSetting(value, fn) {
	const previous = process.env[SERVER_COMPACTION_ENV];
	if (value === undefined) delete process.env[SERVER_COMPACTION_ENV];
	else process.env[SERVER_COMPACTION_ENV] = value;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previous === undefined) delete process.env[SERVER_COMPACTION_ENV];
			else process.env[SERVER_COMPACTION_ENV] = previous;
		});
}

function withFeatureEnabled(fn) {
	return withFeatureSetting("1", fn);
}

function withReasoningReplaySetting(value, fn) {
	const previous = process.env[GPT_REASONING_REPLAY_ENV];
	if (value === undefined) delete process.env[GPT_REASONING_REPLAY_ENV];
	else process.env[GPT_REASONING_REPLAY_ENV] = value;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previous === undefined) delete process.env[GPT_REASONING_REPLAY_ENV];
			else process.env[GPT_REASONING_REPLAY_ENV] = previous;
		});
}

function stubExtension({ fetchFn = async () => compactionResponse(), sleepFn, tools = [] } = {}) {
	const handlers = new Map();
	const renderers = new Map();
	const providers = new Map();
	const appendedEntries = [];
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerProvider: (name, config) => providers.set(name, config),
		registerEntryRenderer: (customType, renderer) => renderers.set(customType, renderer),
		appendEntry: (customType, data) => appendedEntries.push({ customType, data }),
		getAllTools: () => tools,
	};
	createOpenAIServerCompactionExtension({ fetchFn, sleepFn })(pi);
	return { handlers, renderers, providers, appendedEntries };
}

function hookContext(branch, options = {}) {
	const notices = options.notices ?? [];
	const authCalls = options.authCalls ?? [];
	const activeModel = options.model ?? model;
	const sessionId = options.sessionId ?? "session-123";
	return {
		model: activeModel,
		modelRegistry: {
			getApiKeyAndHeaders: async (requestedModel) => {
				authCalls.push(requestedModel);
				return options.auth ?? { ok: true, apiKey: token(), headers: {} };
			},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
			getLeafId: options.getLeafId ?? (() => options.leafId === undefined ? (branch.at(-1)?.id ?? null) : options.leafId),
		},
		hasUI: options.hasUI ?? true,
		ui: { notify: (message, level) => notices.push({ message, level }) },
	};
}

function compactionEvent(branch, options = {}) {
	return {
		branchEntries: branch,
		preparation: {
			firstKeptEntryId: options.firstKeptEntryId ?? branch[0]?.id ?? "u1",
			tokensBefore: options.tokensBefore ?? 50_000,
		},
		customInstructions: options.customInstructions,
		reason: options.reason ?? "manual",
		willRetry: options.willRetry ?? false,
		signal: options.signal ?? new AbortController().signal,
	};
}

function decodeRequestBody(init) {
	const headers = new Headers(init.headers);
	const body = typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body ?? []);
	const decoded = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(body) : body;
	return JSON.parse(decoded.toString("utf8"));
}

async function drain(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

function providerContextFromBranch(branch) {
	return {
		systemPrompt: "base system prompt",
		messages: branch.filter((item) => item.type === "message").map((item) => item.message),
		tools: [],
	};
}

async function runDecoratedRequest(runtime, options = {}) {
	const branch = options.branch ?? [];
	const requestModel = options.model ?? model;
	const provider = runtime.providers.get(requestModel.provider);
	assert.ok(provider?.streamSimple);
	let sentBody;
	let sentHeaders;
	let fetchCalls = 0;
	const stream = provider.streamSimple(
		requestModel,
		options.context ?? providerContextFromBranch(branch),
		{
			apiKey: requestModel.provider === "openai-codex" ? token() : "mirror-test-key",
			...(Object.hasOwn(options, "sessionId") ? { sessionId: options.sessionId } : { sessionId: "session-123" }),
			transport: options.transport ?? "sse",
			cacheRetention: options.cacheRetention,
			headers: options.headers,
			signal: options.signal,
			fetch: async (_url, init) => {
				fetchCalls++;
				sentBody = decodeRequestBody(init);
				sentHeaders = new Headers(init.headers);
				return options.response ?? normalResponse();
			},
			...(options.withoutOnPayload
				? {}
				: {
					onPayload: async (payload) => {
						const ctx = options.ctx ?? hookContext(branch, { model: requestModel });
						let chained = payload;
						if (options.callHook !== false) {
							const result = await runtime.handlers.get("before_provider_request")({ payload: chained }, ctx);
							if (result !== undefined) chained = result;
						}
						return options.downstream ? options.downstream(chained, payload) : chained;
					},
				}),
		},
	);
	const events = await drain(stream);
	return { events, sentBody, sentHeaders, fetchCalls };
}

async function primePreparedPayload(runtime, branch, options = {}) {
	return runDecoratedRequest(runtime, {
		branch,
		model: options.model,
		sessionId: options.sessionId ?? "session-123",
		ctx: options.ctx,
		cacheRetention: options.cacheRetention,
		downstream: options.downstream,
	});
}

function countArtifacts(input) {
	return input.filter((item) => item?.type === "compaction" || item?.type === "compaction_summary").length;
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function theme() {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
	};
}

test("feature defaults on and the canonical backend resolver rejects every endpoint variant", () => {
	assert.equal(featureEnabled(undefined), true);
	for (const value of ["0", "false", " NO ", "OFF"]) assert.equal(featureEnabled(value), false);
	for (const baseUrl of [undefined, "https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/"]) {
		assert.equal(isSupportedCodexModel({ ...model, baseUrl }), true, String(baseUrl));
	}
	assert.equal(isSupportedCodexModel({ ...model, id: "" }), false);
	for (const baseUrl of [
		"http://chatgpt.com/backend-api",
		"https://example.com/backend-api",
		"https://chatgpt.com:443/backend-api",
		"https://user@chatgpt.com/backend-api",
		"https://chatgpt.com/backend-api/codex",
		"https://chatgpt.com/backend-api?x=1",
		"https://chatgpt.com/backend-api#x",
		" https://chatgpt.com/backend-api",
	]) assert.equal(isSupportedCodexModel({ ...model, baseUrl }), false, baseUrl);
	assert.equal(isSupportedCodexModel({ ...model, provider: "openai" }), false);
	assert.equal(isSupportedCodexModel({ ...model, api: "openai-responses" }), false);
});

test("standard Responses compaction uses an exact per-model enterprise-mirror allowlist", () => {
	for (const candidate of [fluxionGpt55, fluxionGpt56, fluxionGrok, fluxionGrok46, xaiGrok46]) {
		assert.equal(isSupportedStandardResponsesModel(candidate), true, `${candidate.provider}/${candidate.id}`);
		assert.equal(isSupportedServerCompactionModel(candidate), true);
		assert.equal(isSupportedStandardResponsesModel({ ...candidate, baseUrl: `${candidate.baseUrl}/` }), true);
	}
	assert.equal(isSupportedServerCompactionModel(model), true);
	for (const candidate of [
		fluxionKimi,
		{ ...fluxionGpt55, id: "gpt-unknown" },
		{ ...fluxionGpt55, provider: "fluxion-cn" },
		{ ...fluxionGpt55, api: "openai-completions" },
		{ ...fluxionGrok, id: "grok-4.7" },
		{ ...fluxionGpt55, baseUrl: "http://fluxionai.space/v1" },
		{ ...fluxionGpt55, baseUrl: "https://fluxionai.space/v1/extra" },
		{ ...fluxionGpt55, baseUrl: "https://fluxionai.space/v1?route=compact" },
		{ ...fluxionGpt55, baseUrl: "https://user@fluxionai.space/v1" },
		{ ...xaiGrok46, baseUrl: "https://api.x.ai" },
		{ ...xaiGrok46, baseUrl: "https://api.x.ai/v1/extra" },
		{ ...xaiGrok46, baseUrl: "http://api.x.ai/v1" },
		{ ...xaiGrok46, api: "openai-completions" },
		{ ...xaiGrok46, provider: "fluxion-grok", id: "grok-4.5" },
		{ ...fluxionGpt55, provider: "xai", id: "grok-4.5" },
		{ ...xaiGrok46, id: "grok-4.7" },
	]) assert.equal(isSupportedStandardResponsesModel(candidate), false, JSON.stringify(candidate));
});

test("standard compact requests project only the unary API fields and use ordinary Bearer JSON headers", () => {
	const prepared = {
		model: fluxionGpt55.id,
		input: [{ role: "user", content: [{ type: "input_text", text: "base" }] }],
		instructions: "preserve this",
		prompt_cache_key: "session-123",
		previous_response_id: "drop",
		stream: true,
		store: false,
		tools: [{ type: "function", name: "tool" }],
		reasoning: { effort: "high" },
		text: { verbosity: "high" },
		include: ["reasoning.encrypted_content"],
	};
	const tail = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "tail" }] }];
	const request = buildStandardCompactionRequest(prepared, tail);
	assert.deepEqual(request.body, {
		model: fluxionGpt55.id,
		input: [...prepared.input, ...tail],
		instructions: "preserve this",
		prompt_cache_key: "session-123",
	});
	assert.equal(countArtifacts(request.body.input), 0);
	const headers = buildStandardCompactionHeaders({
		apiKey: "mirror-key",
		modelHeaders: {
			"User-Agent": "pi-coding-agent",
			"x-codex-beta-features": "must-not-grow",
			"X-Delete-Me": "model-default",
			"x-override-me": "model-default",
			"Content-Encoding": "zstd",
			"CONTENT-Length": "999",
			"Transfer-Encoding": "chunked",
		},
		headers: {
			"x-route": "mirror",
			"x-delete-me": null,
			"X-Override-Me": "resolved-auth",
			authorization: "Bearer hostile",
			accept: "text/plain",
			"content-type": "text/plain",
			"chatgpt-account-id": "hostile-account",
		},
	});
	assert.equal(headers.authorization, "Bearer mirror-key");
	assert.equal(headers.accept, "application/json");
	assert.equal(headers["content-type"], "application/json");
	assert.equal(headers["user-agent"], "pi-coding-agent");
	assert.equal(headers["x-route"], "mirror");
	assert.equal(headers["x-delete-me"], undefined);
	assert.equal(headers["x-override-me"], "resolved-auth");
	assert.equal(headers["chatgpt-account-id"], undefined);
	assert.equal(headers["session-id"], undefined);
	assert.equal(headers["x-codex-beta-features"], undefined);
	assert.equal(headers["content-encoding"], undefined);
	assert.equal(headers["content-length"], undefined);
	assert.equal(headers["transfer-encoding"], undefined);
});

test("standard JSON parser preserves the complete canonical output as-is and rejects false-positive 200s", () => {
	for (const output of [
		standardCompactionOutput({ type: "compaction_summary" }),
		standardCompactionOutput({ type: "compaction", withMessage: false }),
	]) {
		const parsed = parseStandardCompactionResponse(JSON.stringify({
			id: "resp-1",
			output,
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
		}));
		assert.deepEqual(parsed.replacementHistory, output);
		assert.notEqual(parsed.replacementHistory, output);
		assert.equal(parsed.responseId, "resp-1");
	}
	const ordinaryLinkOutput = [
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "See https://example.com/reference?id=42" }] },
		{ type: "compaction", encrypted_content: "opaque" },
	];
	assert.deepEqual(
		parseStandardCompactionResponse(JSON.stringify({ output: ordinaryLinkOutput })).replacementHistory,
		ordinaryLinkOutput,
	);
	for (const value of [
		{ output: [{ type: "reasoning", id: "rs-1" }, { type: "message", role: "assistant", content: [] }] },
		{ output: [] },
		{ output: [{ type: "compaction", encrypted_content: "" }] },
		{ output: [standardCompactionOutput()[1], { type: "compaction", encrypted_content: "two" }] },
		{ output: [{ type: "compaction", encrypted_content: "one" }, { role: "user", content: "after" }] },
		{ output: [{ role: "user", content: [{ type: "input_image", image_url: "https://signed.example/image?token=secret" }] }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ role: "user", content: "Bearer should-not-persist" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", vendor: { "x-api-key": "should-not-persist" } }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", vendor: { "x-auth-token": "should-not-persist" } }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", auth: "should-not-persist" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", vendor: { token: "should-not-persist" } }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", vendor: { session_token: "should-not-persist" } }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", vendor: { oauth_token: "should-not-persist" } }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", encrypted_content: "Bearer should-not-persist" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "compaction", encrypted_content: "one", encryptedContent: "Bearer should-not-persist" }] },
		{ output: [{ type: "message", vendor_client_secret: "should-not-persist" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", vendorClientSecret: "should-not-persist" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", imageUrl: "https://signed.example/image?token=secret" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", note: "https://signed.example/image?token=secret" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", text: "https://signed.example/image?X-Amz-Credential=secret&X-Amz-Signature=sig" }, { type: "compaction", encrypted_content: "one" }] },
		{ output: [{ type: "message", text: "https://signed.example/callback#access_token=secret" }, { type: "compaction", encrypted_content: "one" }] },
	]) assert.throws(() => parseStandardCompactionResponse(JSON.stringify(value)), /expected one final canonical artifact/);
	assert.throws(() => parseStandardCompactionResponse("{broken"), /malformed JSON/);
	assert.throws(() => parseStandardCompactionResponse(JSON.stringify({
		status: "failed",
		output: standardCompactionOutput(),
	})), /non-completed status/);
	assert.equal(parseStandardCompactionResponse(JSON.stringify({
		status: "completed",
		output: standardCompactionOutput(),
	})).replacementHistory.length, 2);
	for (const id of ["Bearer should-not-persist", "sk-abcdefghijklmnop", "bad id with spaces", "x".repeat(257)]) {
		assert.throws(() => parseStandardCompactionResponse(JSON.stringify({
			id,
			output: standardCompactionOutput(),
		})), /invalid response id/);
	}
});

test("xAI compaction responses parse verbatim with reasoning and dropped-message usage", () => {
	const xaiOutput = [{
		type: "compaction",
		id: "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A",
		encrypted_content: "xai-opaque-blob",
	}];
	const parsed = parseStandardCompactionResponse(JSON.stringify({
		id: "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A",
		object: "response.compaction",
		created_at: 1748895600,
		model: "grok-4.6",
		output: xaiOutput,
		usage: {
			input_tokens: 12000,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 800,
			output_tokens_details: { reasoning_tokens: 240 },
			total_tokens: 12800,
			dropped_message_count: 45,
		},
	}));
	assert.deepEqual(parsed.replacementHistory, xaiOutput);
	assert.notEqual(parsed.replacementHistory, xaiOutput);
	assert.equal(parsed.responseId, "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A");
	assert.deepEqual(parsed.rawUsage, {
		input_tokens: 12000,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 800,
		output_tokens_details: { reasoning_tokens: 240 },
		total_tokens: 12800,
		dropped_message_count: 45,
	});
	assert.throws(() => parseStandardCompactionResponse(JSON.stringify({
		object: "response.compaction",
		output: [{ type: "compaction", id: "cmp_ok", encrypted_content: "one" }, { type: "compaction", id: "cmp_extra", encrypted_content: "two" }],
	})), /expected one final canonical artifact/);
});

test("Codex headers merge the feature and safe diagnostics redact bounded credential material", () => {
	const apiKey = token("acct-42");
	assert.equal(extractCodexAccountId(apiKey), "acct-42");
	const headers = buildCodexCompactionHeaders({
		apiKey,
		modelHeaders: {
			"x-model": "yes",
			"X-Delete-Me": "model-default",
			"Content-Encoding": "zstd",
			"content-length": "999",
			"Transfer-Encoding": "chunked",
		},
		headers: {
			"x-codex-beta-features": "other_feature",
			"x-delete-me": null,
			authorization: "Bearer hostile",
			"chatgpt-account-id": "hostile-account",
			accept: "text/plain",
			"content-type": "text/plain",
		},
		sessionId: "session-123",
	});
	assert.equal(headers.authorization, `Bearer ${apiKey}`);
	assert.equal(headers["chatgpt-account-id"], "acct-42");
	assert.equal(headers["x-codex-beta-features"], "other_feature,remote_compaction_v2");
	assert.equal(headers["session-id"], "session-123");
	assert.equal(headers["x-model"], "yes");
	assert.equal(headers["x-delete-me"], undefined);
	assert.equal(headers.session_id, undefined);
	assert.equal(headers["content-encoding"], undefined);
	assert.equal(headers["content-length"], undefined);
	assert.equal(headers["transfer-encoding"], undefined);
	assert.equal(headers.accept, "text/event-stream");
	assert.equal(headers["content-type"], "application/json");
	assert.match(headers["user-agent"], /^pi \(/);
	assert.throws(() => extractCodexAccountId("not-a-jwt"), /account id/);
	const diagnostic = safeDiagnostic(`bad\u001b[31m Bearer abc ${apiKey} sk-abcdefghijklmnop ${"x".repeat(500)}`);
	assert.doesNotMatch(diagnostic, /abc|eyJ|sk-abcdefghijklmnop|\u001b/);
	assert.ok(diagnostic.length <= 320);
});

test("retention is immutable, filters injected context, preserves local images, and truncates UTF-8 text", () => {
	const localImage = "data:image/png;base64,aGVsbG8=";
	const input = [
		{ role: "user", content: [{ type: "input_text", text: "a".repeat(20) }] },
		{ role: "user", content: [{ type: "input_text", text: "<environment_context>private</environment_context>" }] },
		{ role: "assistant", content: [{ type: "output_text", text: "answer" }] },
		{ role: "user", content: [
			{ type: "input_image", image_url: localImage, detail: "auto" },
			{ type: "input_image", image_url: "https://signed.example/image?token=secret", detail: "high" },
			{ type: "input_text", text: "🙂漢字".repeat(12) },
			{ type: "input_text", text: "<hook_prompt hook_run_id=\"hidden\">ignore</hook_prompt>" },
		] },
	];
	const before = structuredClone(input);
	const retained = retainRecentUserItems(input, 8);
	assert.ok(Buffer.byteLength(retained.map((item) => item.content.map((part) => part.text ?? "").join("")).join(""), "utf8") <= 32);
	assert.match(JSON.stringify(retained), /data:image\/png;base64,aGVsbG8=/);
	assert.doesNotMatch(JSON.stringify(retained), /private|ignore|signed\.example|secret/);
	assert.deepEqual(input, before);
	for (const item of retained) {
		for (const part of item.content) {
			if (typeof part.text === "string") assert.doesNotMatch(part.text, /[\uD800-\uDFFF]$/);
		}
	}
});

test("wire artifacts canonicalize aliases and unknown fields before persistence", () => {
	const history = buildReplacementHistory(
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
		{
			type: "compaction_summary",
			id: "cmp-1",
			encrypted_content: "opaque",
			internal_chat_message_metadata_passthrough: { turn_id: "turn-1", secret: "discard" },
			unexpected: "discarded",
		},
	);
	assert.deepEqual(history.at(-1), {
		type: "compaction",
		id: "cmp-1",
		encrypted_content: "opaque",
		internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
	});
	assert.throws(() => buildReplacementHistory([], { type: "compaction" }), /invalid artifact/);
	assert.throws(() => buildReplacementHistory([], {
		type: "compaction",
		id: "sk-abcdefghijklmnop",
		encrypted_content: "opaque",
	}), /invalid artifact/);
	assert.throws(() => buildReplacementHistory([], {
		type: "compaction",
		encrypted_content: "opaque",
		internal_chat_message_metadata_passthrough: {
			turn_id: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature",
		},
	}), /invalid artifact/);
});

test("SSE parsing is strict, deduplicates the two representations, and rejects artifact ambiguity", () => {
	const canonical = { type: "compaction", id: "cmp", encrypted_content: "opaque", extra: "wire-only" };
	const parsed = parseCompactionSse(sse([
		{ type: "response.output_item.done", item: canonical },
		{ type: "response.completed", response: {
			id: "resp-1",
			usage: { input_tokens: 10 },
			output: [{ type: "compaction_summary", id: "cmp", encrypted_content: "opaque", another: true }],
		} },
	]));
	assert.deepEqual(parsed.compactionItem, { type: "compaction", id: "cmp", encrypted_content: "opaque" });
	assert.equal(parsed.responseId, "resp-1");
	assert.equal(parsed.rawUsage.input_tokens, 10);
	// Live Codex streams name events and often omit [DONE]; both must still parse.
	const liveShaped = parseCompactionSse(sse([
		{ type: "response.created", response: { id: "resp-live" } },
		{ type: "response.output_item.done", item: canonical },
		{ type: "response.completed", response: {
			id: "resp-live",
			usage: { input_tokens: 11, output_tokens: 2, input_tokens_details: { cached_tokens: 9 } },
			output: [{ type: "compaction", id: "cmp", encrypted_content: "opaque" }],
		} },
	], { done: false, namedEvents: true }));
	assert.deepEqual(liveShaped.compactionItem, { type: "compaction", id: "cmp", encrypted_content: "opaque" });
	assert.equal(liveShaped.responseId, "resp-live");
	const crOnly = sse([
		{ type: "response.completed", response: { status: "completed", output: [canonical] } },
	], { done: false, namedEvents: true })
		.replace("event: response.completed", "future-field: accepted\nevent: response.completed")
		.replaceAll("\n", "\r");
	assert.deepEqual(parseCompactionSse(crOnly).compactionItem, {
		type: "compaction",
		id: "cmp",
		encrypted_content: "opaque",
	});
	assert.throws(() => parseCompactionSse("data: {broken}\n\n"), /malformed SSE JSON/);
	assert.throws(() => parseCompactionSse("event: only\n\n"), /before completion/);
	assert.throws(() => parseCompactionSse(sse([])), /before completion/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "one" } },
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "one" } },
		{ type: "response.completed", response: {} },
	])), /received 2/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "one" } },
		{ type: "response.completed", response: { output: [{ type: "compaction", encrypted_content: "two" }] } },
	])), /conflicting/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "" } },
		{ type: "response.completed", response: {} },
	])), /invalid streamed artifact/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.completed", response: { output: "not-an-array" } },
	])), /invalid completed output/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.completed", response: { status: "incomplete", output: [canonical] } },
	])), /invalid status incomplete/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.completed", response: { status: "completed", output: [canonical] } },
		{ type: "response.output_item.done", item: canonical },
	])), /data after completion/);
	assert.throws(() => parseCompactionSse(sse([
		{ type: "response.completed", response: { status: "completed", output: [canonical] } },
		{ type: "future.event", value: true },
	])), /data after completion/);
	assert.throws(() => parseCompactionSse(sse([{ type: "error", message: "Bearer secret failed" }])), /Bearer <redacted>/);
});

test("Codex completion and artifact identifiers are bounded, non-secret, and terminal status is explicit", () => {
	const artifact = { type: "compaction", id: "cmp-safe", encrypted_content: "opaque" };
	const completed = (response) => sse([{ type: "response.completed", response: { output: [artifact], ...response } }]);
	assert.equal(parseCompactionSse(completed({ id: "resp_abc-1:2", status: "completed" })).responseId, "resp_abc-1:2");
	for (const id of ["", "x".repeat(257), "sk-abcdefghijklmnop", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature"]) {
		assert.throws(() => parseCompactionSse(completed({ id, status: "completed" })), /invalid response id/);
	}
	for (const status of [null, 42, "failed"]) {
		assert.throws(() => parseCompactionSse(completed({ status })), /invalid status/);
	}
	for (const unsafeArtifact of [
		{ ...artifact, id: "sk-abcdefghijklmnop" },
		{ ...artifact, internal_chat_message_metadata_passthrough: { turn_id: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature" } },
	]) {
		assert.throws(
			() => parseCompactionSse(sse([{ type: "response.completed", response: { status: "completed", output: [unsafeArtifact] } }])),
			/invalid completed artifact/,
		);
	}
	assert.throws(
		() => parseCompactionSse(completed({
			status: "completed",
			error: { code: "server_is_overloaded", message: "temporarily busy" },
		})),
		/temporarily busy/,
	);
});

test("the production request builder preserves every final non-history field", async () => {
	const initial = {
		model: model.id,
		input: [{ role: "user", content: "hello" }],
		instructions: "base instructions",
		tools: [{ type: "function", name: "exec", parameters: { type: "object" }, strict: null }],
		parallel_tool_calls: false,
		tool_choice: "auto",
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		text: { verbosity: "high" },
		reasoning: { effort: "low", summary: "auto" },
		prompt_cache_key: "session-123",
		service_tier: "priority",
		custom_lite_marker: "all_turns",
		previous_response_id: "must-be-removed",
	};
	const prepared = await resolveFinalProviderPayload(initial, model, async (payload) => ({
		...payload,
		instructions: `${payload.instructions}\n\nlate instruction`,
		late_extension_marker: true,
	}));
	const tail = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }];
	const { body, compactedInput } = buildPreparedCompactionRequest(prepared, tail);
	for (const key of Object.keys(prepared)) {
		if (key === "input" || key === "previous_response_id") continue;
		assert.deepEqual(body[key], prepared[key], key);
	}
	assert.deepEqual(compactedInput, [...initial.input, ...tail]);
	assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
	assert.equal(body.previous_response_id, undefined);
});

test("remote usage is costed and formatted", () => {
	const remote = parseRemoteUsage(model, {
		input_tokens: 100,
		output_tokens: 20,
		total_tokens: 120,
		input_tokens_details: { cached_tokens: 30, cache_creation_tokens: 10 },
	});
	assert.deepEqual(
		{ input: remote.input, output: remote.output, cacheRead: remote.cacheRead, cacheWrite: remote.cacheWrite },
		{ input: 60, output: 20, cacheRead: 30, cacheWrite: 10 },
	);
	assert.ok(remote.cost.total > 0);
	assert.equal(formatCompactionUsage(remote), "Compaction V2 · input 100 · cache read 30 (30.0%) · cache write 10 · output 20");
	assert.equal(parseRemoteUsage(model, {
		input_tokens: 100,
		output_tokens: 20,
		total_tokens: 120,
		input_tokens_details: { cached_tokens: 101 },
	}), undefined);
	assert.equal(parseRemoteUsage(model, {
		input_tokens: 100,
		output_tokens: 20,
		total_tokens: 119,
	}), undefined);
	assert.equal(parseRemoteUsage(model, {
		input_tokens: 100.5,
		output_tokens: 20,
		total_tokens: 120.5,
	}), undefined);
});

test("persisted native history is strict, bounded, JSON-round-trippable, and rejects the old schema", () => {
	const valid = nativeDetails({
		replacementHistory: [
			{ type: "message", role: "user", content: [
				{ type: "input_text", text: "hello" },
				{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
			] },
			{ type: "compaction", encrypted_content: "opaque" },
		],
	});
	assert.deepEqual(extractServerCompactionDetails(JSON.parse(JSON.stringify(valid))).replacementHistory, valid.replacementHistory);
	const legacyCodex = structuredClone(valid);
	delete legacyCodex.adapter;
	assert.equal(extractServerCompactionDetails(legacyCodex).adapter, "codex-trigger-sse");
	const adapterlessStandard = standardNativeDetails();
	delete adapterlessStandard.adapter;
	assert.equal(extractServerCompactionDetails(adapterlessStandard), undefined);
	assert.equal(extractServerCompactionDetails({ "renPublicPackage.openaiServerCompaction": valid }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, replacementHistory: [
		{ type: "compaction_summary", encrypted_content: "opaque" },
	] }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, replacementHistory: [
		{ type: "compaction", encrypted_content: "opaque", extra: true },
	] }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, replacementHistory: [
		{ type: "reasoning", encrypted_content: "foreign" },
		{ type: "compaction", encrypted_content: "opaque" },
	] }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, replacementHistory: [
		{ type: "message", role: "user", content: [
			{ type: "input_image", image_url: "https://signed.example/image?token=secret", detail: "auto" },
		] },
		{ type: "compaction", encrypted_content: "opaque" },
	] }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, replacementHistory: [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "🙂".repeat(RETAINED_USER_TOKEN_BUDGET + 1) }] },
		{ type: "compaction", encrypted_content: "opaque" },
	] }), undefined);
	assert.equal(extractServerCompactionDetails(nativeDetails({
		replacementHistory: [{ type: "compaction", encrypted_content: "x".repeat(MAX_REPLACEMENT_HISTORY_BYTES) }],
	})), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, replacementHistory: [] }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, responseId: "sk-abcdefghijklmnop" }), undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, usage: { input: "invalid" } }).usage, undefined);
	assert.equal(extractServerCompactionDetails({ ...valid, usage: {
		...usage(),
		totalTokens: 1,
	} }).usage, undefined);
});

test("latest checkpoint classification permits same-endpoint model replay and rejects malformed ownership", async () => {
	const compacted = compactionEntry("c1", null, nativeDetails());
	const current = userEntry("u2", "c1", "new");
	const foreign = assistantEntry("a2", "u2", "foreign reply", {
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude",
	});
	const replay = await reconstructReplayHistory([compacted, current, foreign], { ...model, id: "gpt-next" });
	assert.equal(replay[0].type, "compaction");
	assert.match(JSON.stringify(replay), /new|foreign reply/);
	await assert.rejects(
		() => reconstructReplayHistory([compacted], { ...model, baseUrl: "https://chatgpt.com/other" }),
		/compaction endpoint|provider endpoint/,
	);
	const wrongShim = compactionEntry("c2", "a2", nativeDetails(), "not the native shim");
	await assert.rejects(() => reconstructReplayHistory([compacted, current, foreign, wrongShim], model), /missing or invalid/);
	const newerPlain = compactionEntry("c3", "a2", { readFiles: [] }, "portable fallback");
	assert.equal(await reconstructReplayHistory([compacted, current, foreign, newerPlain], model), undefined);
});

test("adapterless 0.9.2 Codex checkpoints resume through decorated replay", async () => {
	await withFeatureEnabled(async () => {
		const legacy = nativeDetails();
		delete legacy.adapter;
		const branch = [
			compactionEntry("c1", null, legacy),
			userEntry("u2", "c1", "legacy tail"),
		];
		const runtime = stubExtension();
		const replay = await runDecoratedRequest(runtime, { branch });
		assert.equal(replay.fetchCalls, 1);
		assert.equal(countArtifacts(replay.sentBody.input), 1);
		assert.match(JSON.stringify(replay.sentBody.input), /opaque|legacy tail/);
	});
});

test("Pi summarizer detection requires both its instruction signature and structured conversation envelope", () => {
	const payload = {
		model: model.id,
		instructions: SUMMARIZATION_SYSTEM_PROMPT,
		input: [
			{ role: "developer", content: "leading developer item" },
			{ role: "user", content: [{ type: "input_text", text: summaryPrompt() }] },
		],
	};
	assert.equal(isPiSummarizationPayload(payload), true);
	assert.equal(isPiSummarizationPayload({
		instructions: SUMMARIZATION_SYSTEM_PROMPT,
		input: [{ role: "user", content: `<conversation>\n[User]: split turn\n</conversation>\n\n## Original Request\n...\n## Early Progress\n...\n## Context for Suffix\n...` }],
	}), true);
	assert.equal(isPiSummarizationPayload({ ...payload, instructions: "ordinary" }), false);
	assert.equal(isPiSummarizationPayload({
		instructions: SUMMARIZATION_SYSTEM_PROMPT,
		input: [{ role: "user", content: "I merely mentioned <conversation>hello</conversation>" }],
	}), false);
	const replay = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
		{ type: "compaction", encrypted_content: "opaque" },
	];
	const once = injectReplayIntoSummarizationPayload(payload, replay);
	const twice = injectReplayIntoSummarizationPayload(once, replay);
	assert.equal(countArtifacts(twice.input), 1);
	assert.equal(twice.instructions, SUMMARIZATION_SYSTEM_PROMPT);
	assert.equal(twice.input[0].role, "developer");
	assert.match(JSON.stringify(twice.input), /<conversation>|retained/);
});

test("snapshot builder validates session/model/branch and delegates all tail conversion to Pi", async () => {
	const branch = [
		userEntry("u0", null, "base"),
		assistantEntry("a1", "u0", "", {
			content: [{
				type: "thinking",
				thinking: "summary",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_1",
					summary: [{ type: "summary_text", text: "summary" }],
					encrypted_content: "sealed-reasoning",
				}),
			}],
		}),
		assistantEntry("err", "a1", "error partial", { stopReason: "error" }),
		assistantEntry("abort", "err", "abort partial", { stopReason: "aborted" }),
		assistantEntry("foreign", "abort", "foreign completed", {
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude",
		}),
	];
	const snapshot = {
		sessionId: "session-123",
		leafId: "u0",
		identity: { adapter: "codex-trigger-sse", provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl },
		payload: { model: model.id, input: [{ type: "message", role: "user", content: "base" }], marker: true },
	};
	const beforeBranch = structuredClone(branch);
	const beforeSnapshot = structuredClone(snapshot);
	const request = await buildCompactionRequestFromSnapshot(snapshot, branch, model, "session-123");
	const serialized = JSON.stringify(request.compactedInput);
	assert.match(serialized, /sealed-reasoning/);
	assert.match(serialized, /foreign completed/);
	assert.doesNotMatch(serialized, /error partial|abort partial/);
	assert.equal(request.body.marker, true);
	assert.deepEqual(branch, beforeBranch);
	assert.deepEqual(snapshot, beforeSnapshot);
	await assert.rejects(() => buildCompactionRequestFromSnapshot(snapshot, branch, model, "other-session"), /different session/);
	await assert.rejects(() => buildCompactionRequestFromSnapshot(snapshot, branch, { ...model, id: "gpt-next" }, "session-123"), /different model/);
	await assert.rejects(() => buildCompactionRequestFromSnapshot({
		...snapshot,
		payload: { ...snapshot.payload, model: "hook-rewritten-model" },
	}, branch, model, "session-123"), /changed the selected model/);
	const disconnected = [branch[0], { ...branch[1], parentId: "other" }];
	await assert.rejects(() => buildCompactionRequestFromSnapshot(snapshot, disconnected, model, "session-123"), /not an ancestor/);
});

test("native checkpoint tail conversion preserves cross-provider GPT reasoning with paired text and sanitized tools", () => withReasoningReplaySetting("1", async () => {
	const targetModel = { ...model, id: "gpt-5.6-luna" };
	const textSignature = JSON.stringify({
		type: "reasoning",
		id: "rs_cross_text",
		summary: [],
		encrypted_content: "sealed-cross-text",
	});
	const toolSignature = JSON.stringify({
		type: "reasoning",
		id: "rs_cross_tool",
		summary: [],
		encrypted_content: "sealed-cross-tool",
	});
	const branch = [
		compactionEntry("c1", null, nativeDetails()),
		assistantEntry("a2", "c1", "", {
			provider: "ccapi-gpt",
			api: "openai-responses",
			model: "gpt-5.6-sol",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: textSignature },
				{ type: "text", text: "READY", textSignature: JSON.stringify({ v: 1, id: "msg_cross_text" }) },
			],
		}),
		assistantEntry("a3", "a2", "", {
			provider: "fluxion-gpt",
			api: "openai-responses",
			model: "other-gpt",
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "", thinkingSignature: toolSignature },
				{ type: "toolCall", id: "call_cross|fc_cross", name: "lookup", arguments: { query: "safe" }, thoughtSignature: "drop-me" },
			],
		}),
		entry("t4", "a3", {
			role: "toolResult",
			toolCallId: "call_cross|fc_cross",
			toolName: "lookup",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 4,
		}),
	];
	const replay = await reconstructReplayHistory(branch, targetModel);
	assert.ok(replay);
	assert.equal(countArtifacts(replay), 1);
	const reasoning = replay.filter((item) => item.type === "reasoning");
	assert.deepEqual(reasoning.map((item) => ({ id: item.id, encrypted_content: item.encrypted_content })), [
		{ id: "rs_cross_text", encrypted_content: "sealed-cross-text" },
		{ id: "rs_cross_tool", encrypted_content: "sealed-cross-tool" },
	]);
	const text = replay.find((item) => item.type === "message" && item.role === "assistant");
	assert.equal(text.id, "msg_cross_text");
	const call = replay.find((item) => item.type === "function_call");
	assert.equal(call.id, undefined);
	assert.equal(call.call_id, "call_cross");
	const result = replay.find((item) => item.type === "function_call_output");
	assert.equal(result.call_id, "call_cross");

	const snapshotRequest = await buildCompactionRequestFromSnapshot({
		sessionId: "session-cross",
		leafId: "c1",
		identity: {
			adapter: "codex-trigger-sse",
			provider: targetModel.provider,
			api: targetModel.api,
			model: targetModel.id,
			baseUrl: targetModel.baseUrl,
		},
		payload: { model: targetModel.id, input: [{ type: "compaction", encrypted_content: "snapshot-opaque" }] },
	}, branch, targetModel, "session-cross");
	const snapshotReasoning = snapshotRequest.compactedInput.filter((item) => item.type === "reasoning");
	assert.deepEqual(snapshotReasoning.map((item) => ({ id: item.id, encrypted_content: item.encrypted_content })), [
		{ id: "rs_cross_text", encrypted_content: "sealed-cross-text" },
		{ id: "rs_cross_tool", encrypted_content: "sealed-cross-tool" },
	]);
}));

test("disabling GPT reasoning replay restores Pi's default native-tail conversion", () => withReasoningReplaySetting("0", async () => {
	const targetModel = { ...model, id: "gpt-5.6-luna" };
	const source = assistantEntry("a2", "c1", "", {
		provider: "ccapi-gpt",
		api: "openai-responses",
		model: "gpt-5.6-sol",
		content: [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: "rs_disabled",
					summary: [],
					encrypted_content: "sealed-disabled",
				}),
			},
			{ type: "text", text: "DEFAULT", textSignature: JSON.stringify({ v: 1, id: "msg_foreign" }) },
		],
	});
	const replay = await reconstructReplayHistory([
		compactionEntry("c1", null, nativeDetails()),
		source,
	], targetModel);
	assert.ok(replay);
	assert.equal(replay.some((item) => item.type === "reasoning" && item.id === "rs_disabled"), false);
	const message = replay.find((item) => item.type === "message" && item.role === "assistant");
	assert.notEqual(message.id, "msg_foreign");
}));

test("snapshot builder preserves deferred tool-search records when converting a branch tail", async () => {
	const branch = [
		userEntry("u0", null, "base"),
		entry("a1", "u0", {
			role: "assistant",
			provider: model.provider,
			api: model.api,
			model: model.id,
			content: [{ type: "toolCall", id: "call-1|fc_1", name: "exec", arguments: {} }],
			stopReason: "toolUse",
			usage: usage(),
			timestamp: 2,
		}),
		entry("t1", "a1", {
			role: "toolResult",
			toolCallId: "call-1|fc_1",
			toolName: "exec",
			content: [{ type: "text", text: "loaded" }],
			addedToolNames: ["deferred_read"],
			isError: false,
			timestamp: 3,
		}),
	];
	const snapshot = {
		sessionId: "session-123",
		leafId: "u0",
		identity: { adapter: "codex-trigger-sse", provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl },
		payload: { model: model.id, input: [{ type: "message", role: "user", content: "base" }] },
	};
	const tools = [{ name: "deferred_read", description: "read", parameters: { type: "object" } }];
	const request = await buildCompactionRequestFromSnapshot(snapshot, branch, {
		...model,
		compat: { supportsToolSearch: true },
	}, "session-123", tools);
	assert.equal(request.compactedInput.some((item) => item.type === "tool_search_call"), true);
	assert.equal(request.compactedInput.some((item) => item.type === "tool_search_output"), true);
});

test("extension tail conversion uses the full tool catalog only to reconstruct historical deferred loads", async () => {
	await withFeatureEnabled(async () => {
		let compactBody;
		const deferredTool = { name: "deferred_read", description: "read", parameters: { type: "object" } };
		const inactiveDecoy = { name: "inactive_decoy", description: "unused", parameters: { type: "object" } };
		const runtime = stubExtension({
			tools: [inactiveDecoy, deferredTool],
			fetchFn: async (_url, init) => {
				compactBody = JSON.parse(init.body);
				return compactionResponse();
			},
		});
		const toolSearchModel = { ...model, compat: { supportsToolSearch: true } };
		const branch = [userEntry("u0", null, "base")];
		await primePreparedPayload(runtime, branch, { model: toolSearchModel });
		branch.push(
			entry("a1", "u0", {
				role: "assistant",
				provider: model.provider,
				api: model.api,
				model: model.id,
				content: [{ type: "toolCall", id: "call-1|fc_1", name: "loader", arguments: {} }],
				stopReason: "toolUse",
				usage: usage(),
				timestamp: 2,
			}),
			entry("t1", "a1", {
				role: "toolResult",
				toolCallId: "call-1|fc_1",
				toolName: "loader",
				content: [{ type: "text", text: "loaded" }],
				addedToolNames: ["deferred_read"],
				isError: false,
				timestamp: 3,
			}),
		);
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: toolSearchModel }),
		);
		assert.equal(result.compaction.summary, SERVER_COMPACTION_SHIM_SUMMARY);
		const serialized = JSON.stringify(compactBody.input);
		assert.match(serialized, /tool_search_call|tool_search_output/);
		assert.match(serialized, /deferred_read/);
		assert.doesNotMatch(serialized, /inactive_decoy/);
	});
});

test("decorated normal requests provisionally expose replay then defeat hostile downstream input replacement", async () => {
	await withFeatureEnabled(async () => {
		const branch = [compactionEntry("c1", null, nativeDetails()), userEntry("u2", "c1", "continue")];
		const runtime = stubExtension();
		let provisional;
		const result = await runDecoratedRequest(runtime, {
			branch,
			downstream: (chained) => {
				provisional = structuredClone(chained);
				return { ...chained, input: [{ role: "user", content: "hostile replacement" }], late_marker: true };
			},
		});
		assert.equal(countArtifacts(provisional.input), 1);
		assert.equal(result.fetchCalls, 1);
		assert.equal(countArtifacts(result.sentBody.input), 1);
		assert.match(JSON.stringify(result.sentBody.input), /continue/);
		assert.doesNotMatch(JSON.stringify(result.sentBody.input), /hostile replacement/);
		assert.equal(result.sentBody.late_marker, true);
		assert.equal(result.sentBody.previous_response_id, undefined);
	});
});

test("decorated summarizer requests preserve instructions/conversation and terminally collapse duplicate replay windows", async () => {
	await withFeatureEnabled(async () => {
		const branch = [compactionEntry("c1", null, nativeDetails())];
		const runtime = stubExtension();
		const result = await runDecoratedRequest(runtime, {
			branch,
			context: summaryProviderContext("summary target"),
			downstream: (chained) => ({ ...chained, input: [...chained.input, ...chained.input] }),
		});
		assert.equal(result.fetchCalls, 1);
		assert.equal(countArtifacts(result.sentBody.input), 1);
		assert.equal(result.sentBody.instructions, SUMMARIZATION_SYSTEM_PROMPT);
		assert.equal(result.sentBody.input.filter((item) => JSON.stringify(item).includes("<conversation>")).length, 1);
		assert.match(JSON.stringify(result.sentBody.input), /summary target/);
	});
});

test("native ownership blocks null, array, primitive, and malformed object final payloads before fetch", async () => {
	await withFeatureEnabled(async () => {
		for (const finalValue of [null, [], "primitive", { model: model.id, input: [42] }]) {
			const branch = [compactionEntry("c1", null, nativeDetails())];
			const runtime = stubExtension();
			const result = await runDecoratedRequest(runtime, { branch, downstream: () => finalValue });
			assert.equal(result.fetchCalls, 0, JSON.stringify(finalValue));
			assert.equal(result.events.at(-1).type, "error");
			assert.match(result.events.at(-1).error.errorMessage, /malformed final provider payload/);
		}
	});
});

test("native ownership blocks missing session and prepared-model identity mismatches before transport", async () => {
	await withFeatureEnabled(async () => {
		for (const variant of ["missing-session", "model-mismatch"]) {
			const branch = [compactionEntry("c1", null, nativeDetails())];
			const runtime = stubExtension();
			const result = variant === "missing-session"
				? await runDecoratedRequest(runtime, { branch, sessionId: undefined })
				: await runDecoratedRequest(runtime, {
					branch,
					model: { ...model, id: "gpt-next" },
					ctx: hookContext(branch, { model }),
				});
			assert.equal(result.fetchCalls, 0, variant);
			assert.equal(result.events.at(-1).type, "error");
			assert.match(result.events.at(-1).error.errorMessage, /metadata did not match/);
		}
	});
});

test("AsyncLocalStorage prevents barrier-interleaved requests from cross-wiring snapshots", async () => {
	await withFeatureEnabled(async () => {
		let remoteFetches = 0;
		const runtime = stubExtension({ fetchFn: async () => {
			remoteFetches++;
			return compactionResponse();
		} });
		const provider = runtime.providers.get("openai-codex");
		const branchA = [userEntry("a-user", null, "A")];
		const branchB = [userEntry("b-user", null, "B")];
		const enteredA = createDeferred();
		const enteredB = createDeferred();
		const releaseA = createDeferred();
		const releaseB = createDeferred();

		const start = (branch, sessionId, entered, release) => provider.streamSimple(
			model,
			providerContextFromBranch(branch),
			{
				apiKey: token(),
				sessionId,
				transport: "sse",
				fetch: async () => normalResponse(),
				onPayload: async (payload) => {
					const rewritten = await runtime.handlers.get("before_provider_request")(
						{ payload },
						hookContext(branch, { sessionId }),
					);
					entered.resolve();
					await release.promise;
					return rewritten;
				},
			},
		);

		const streamA = start(branchA, "session-A", enteredA, releaseA);
		await enteredA.promise;
		const streamB = start(branchB, "session-B", enteredB, releaseB);
		await enteredB.promise;
		releaseB.resolve();
		await drain(streamB);
		releaseA.resolve();
		await drain(streamA);

		const authA = [];
		const failedA = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branchA),
			hookContext(branchA, { sessionId: "session-A", authCalls: authA }),
		);
		assert.equal(failedA, undefined);
		assert.equal(authA.length, 0);
		assert.equal(remoteFetches, 0);

		const authB = [];
		const succeededB = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branchB),
			hookContext(branchB, { sessionId: "session-B", authCalls: authB }),
		);
		assert.equal(succeededB.compaction.summary, SERVER_COMPACTION_SHIM_SUMMARY);
		assert.equal(authB.length, 1);
		assert.equal(remoteFetches, 1);
	});
});

test("supported enabled calls force the shared SSE feature lane while opt-out and unsupported endpoints stay unchanged", async () => {
	const runtime = stubExtension();
	await withFeatureEnabled(async () => {
		const supported = await runDecoratedRequest(runtime, {
			branch: [],
			model: { ...model, baseUrl: `${model.baseUrl}/`, headers: { "X-Delete-Me": "model-default" } },
			transport: "websocket",
			headers: { "x-codex-beta-features": "other", "x-original": "yes", "x-delete-me": null },
			callHook: false,
		});
		assert.equal(supported.fetchCalls, 1, "websocket preference was forced onto SSE");
		assert.equal(supported.sentHeaders.get("x-codex-beta-features"), "other,remote_compaction_v2");
		assert.equal(supported.sentHeaders.get("x-original"), "yes");
		assert.equal(supported.sentHeaders.get("x-delete-me"), null);

		const unsupported = await runDecoratedRequest(runtime, {
			branch: [],
			model: { ...model, baseUrl: "https://chatgpt.com/other" },
			transport: "sse",
			headers: { "x-codex-beta-features": "other", "x-original": "yes" },
			callHook: false,
		});
		assert.equal(unsupported.sentHeaders.get("x-codex-beta-features"), "other");
		assert.equal(unsupported.sentHeaders.get("x-original"), "yes");
	});
	await withFeatureSetting("0", async () => {
		const optedOut = await runDecoratedRequest(runtime, {
			branch: [],
			transport: "sse",
			headers: { "x-codex-beta-features": "other" },
			callHook: false,
		});
		assert.equal(optedOut.sentHeaders.get("x-codex-beta-features"), "other");
	});
});

test("a lifecycle reset while replay ownership is arming blocks provider transport", async () => {
	await withFeatureEnabled(async () => {
		const runtime = stubExtension();
		const branch = [
			compactionEntry("c1", null, nativeDetails()),
			userEntry("u2", "c1", "tail"),
		];
		let reset = false;
		const ctx = hookContext(branch, {
			getLeafId: () => {
				if (!reset) {
					reset = true;
					runtime.handlers.get("session_tree")({}, hookContext(branch));
				}
				return branch.at(-1).id;
			},
		});
		const result = await runDecoratedRequest(runtime, { branch, ctx });
		assert.equal(reset, true);
		assert.equal(result.fetchCalls, 0);
		assert.equal(result.events.at(-1)?.type, "error");
	});
});

test("missing matching decorator scope returns a locally untransportable fail-closed payload", async () => {
	await withFeatureEnabled(async () => {
		const runtime = stubExtension();
		const branch = [
			compactionEntry("c1", null, nativeDetails()),
			userEntry("u2", "c1", "tail"),
		];
		const blocked = await runtime.handlers.get("before_provider_request")(
			{ payload: { model: model.id, input: [{ role: "user", content: "shim" }] } },
			hookContext(branch),
		);
		assert.throws(() => JSON.stringify(blocked), /circular/i);
	});
});

test("standard adapters preserve model catalogs, create canonical checkpoints, and replay them exactly", async () => {
	await withFeatureEnabled(async () => {
		const cases = [
			[fluxionGpt55, standardCompactionOutput({ encrypted: "g55", type: "compaction_summary" })],
			[fluxionGpt56, standardCompactionOutput({ encrypted: "g56", type: "compaction_summary" })],
			[fluxionGrok, standardCompactionOutput({ encrypted: "grok", type: "compaction", withMessage: false })],
			[fluxionGrok46, standardCompactionOutput({ encrypted: "grok46", type: "compaction", withMessage: false })],
			[xaiGrok46, [{ type: "compaction", id: "cmp_01HZ9P0V8M2YQK3F7C4G6N5R2A", encrypted_content: "xai" }]],
		];
		for (const [activeModel, output] of cases) {
			const compactionModel = {
				...activeModel,
				headers: { "X-Delete-Me": "model-default", "x-keep-me": "model-default", "Content-Encoding": "zstd" },
			};
			let compactRequest;
			const runtime = stubExtension({ fetchFn: async (url, init) => {
				compactRequest = { url, init };
				return standardCompactionResponse({ output });
			} });
			assert.deepEqual([...runtime.providers.keys()].sort(), ["fluxion-gpt", "fluxion-grok", "openai-codex", "xai"]);
			assert.equal(runtime.providers.get(activeModel.provider).api, "openai-responses");
			assert.equal(runtime.providers.get(activeModel.provider).models, undefined);

			const branch = [userEntry("u1", null, "old marker")];
			await primePreparedPayload(runtime, branch, {
				model: compactionModel,
				downstream: (payload) => ({ ...payload, enterprise_marker: "normal-only" }),
			});
			const result = await runtime.handlers.get("session_before_compact")(
				compactionEvent(branch),
				hookContext(branch, { model: compactionModel, auth: {
					ok: true,
					apiKey: "mirror-key",
					headers: { "User-Agent": "pi-coding-agent", "x-delete-me": null },
				} }),
			);
			assert.equal(compactRequest.url, `${activeModel.baseUrl}/responses/compact`);
			const headers = new Headers(compactRequest.init.headers);
			assert.equal(headers.get("authorization"), "Bearer mirror-key");
			assert.equal(headers.get("x-delete-me"), null);
			assert.equal(headers.get("x-keep-me"), "model-default");
			assert.equal(headers.get("content-encoding"), null);
			assert.equal(headers.get("accept"), "application/json");
			assert.equal(headers.get("chatgpt-account-id"), null);
			assert.equal(headers.get("x-codex-beta-features"), null);
			const body = JSON.parse(compactRequest.init.body);
			assert.deepEqual(Object.keys(body).sort(), ["input", "model", "prompt_cache_key"]);
			assert.equal(body.model, activeModel.id);
			assert.equal(countArtifacts(body.input), 0);
			assert.equal(body.enterprise_marker, undefined);
			assert.equal(result.compaction.details.adapter, "standard-responses-json");
			assert.deepEqual(result.compaction.details.replacementHistory, output);
			assert.deepEqual(
				extractServerCompactionDetails(JSON.parse(JSON.stringify(result.compaction.details))).replacementHistory,
				output,
			);

			const saved = compactionEntry("c1", null, result.compaction.details);
			const replayBranch = [saved, userEntry("u2", "c1", "new tail")];
			const replay = await runDecoratedRequest(runtime, { branch: replayBranch, model: activeModel });
			assert.deepEqual(replay.sentBody.input.slice(0, output.length), output);
			assert.equal(countArtifacts(replay.sentBody.input), 1);
			assert.match(JSON.stringify(replay.sentBody.input), /new tail/);
		}
	});
});

test("standard payload model rewrites invalidate fresh snapshots and block owned replay", async () => {
	await withFeatureEnabled(async () => {
		const freshBranch = [userEntry()];
		const freshRuntime = stubExtension();
		const normal = await runDecoratedRequest(freshRuntime, {
			branch: freshBranch,
			model: fluxionGpt55,
			downstream: (payload) => ({ ...payload, model: "unqualified-model" }),
		});
		assert.equal(normal.fetchCalls, 1);
		const authCalls = [];
		assert.equal(await freshRuntime.handlers.get("session_before_compact")(
			compactionEvent(freshBranch),
			hookContext(freshBranch, { model: fluxionGpt55, authCalls }),
		), undefined);
		assert.equal(authCalls.length, 0);

		const ownedBranch = [compactionEntry("c1", null, standardNativeDetails(fluxionGpt55))];
		const ownedRuntime = stubExtension();
		const owned = await runDecoratedRequest(ownedRuntime, {
			branch: ownedBranch,
			model: fluxionGpt55,
			downstream: (payload) => ({ ...payload, model: "unqualified-model" }),
		});
		assert.equal(owned.fetchCalls, 0);
		assert.equal(owned.events.at(-1).type, "error");
		assert.match(owned.events.at(-1).error.errorMessage, /changed the selected model/);
	});
});

test("standard adapter treats a 200 response without an artifact as permanent Pi fallback", async () => {
	await withFeatureEnabled(async () => {
		let attempts = 0;
		const runtime = stubExtension({ fetchFn: async () => {
			attempts++;
			return standardCompactionResponse({ output: [
				{ type: "reasoning", id: "rs-kimi", summary: [] },
				{ type: "message", role: "assistant", content: [] },
			] });
		} });
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch, { model: fluxionGpt55 });
		const notices = [];
		assert.equal(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, notices, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		), undefined);
		assert.equal(attempts, 1);
		assert.match(notices.at(-1).message, /Pi compaction will run/);
		assert.equal(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionKimi }),
		), undefined);
	});
});

test("failed native creation persists a redacted warning after readable Pi fallback", async () => {
	await withFeatureEnabled(async () => {
		const runtime = stubExtension({ fetchFn: async () => new Response(JSON.stringify({
			error: { code: "invalid_api_key", message: "Bearer should-not-persist; active key mirror-key" },
		}), { status: 200 }) });
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch, { model: fluxionGpt55 });
		assert.equal(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		), undefined);
		assert.equal(runtime.appendedEntries.length, 0, "branch is not mutated before Pi fallback completes");
		assert.deepEqual(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55 }),
		), { cancel: true }, "a second compaction cannot steal an awaiting fallback slot");

		const fallbackEntry = compactionEntry("c1", "u1", { readFiles: [] }, "readable Pi summary");
		runtime.handlers.get("session_compact")(
			{ compactionEntry: fallbackEntry, fromExtension: false, reason: "threshold", willRetry: false },
			hookContext([...branch, fallbackEntry], { model: fluxionGpt55 }),
		);
		assert.equal(runtime.appendedEntries.length, 1);
		assert.equal(runtime.appendedEntries[0].customType, SERVER_COMPACTION_FALLBACK_ENTRY_TYPE);
		assert.doesNotMatch(JSON.stringify(runtime.appendedEntries[0]), /should-not-persist|mirror-key/);
		assert.match(runtime.appendedEntries[0].data.reason, /Bearer <redacted>.*active key <redacted>/);

		const renderer = runtime.renderers.get(SERVER_COMPACTION_FALLBACK_ENTRY_TYPE);
		const rendered = renderer(
			{ data: runtime.appendedEntries[0].data },
			{ expanded: false },
			theme(),
		).render(72).join("\n");
		const normalized = rendered.replace(/\s+/g, " ");
		assert.match(normalized, new RegExp(SERVER_COMPACTION_FALLBACK_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(normalized, /Reason:.*Bearer <redacted>/);

		const resetRuntime = stubExtension({ fetchFn: async () => new Response(JSON.stringify({
			error: { code: "invalid_api_key", message: "reset-me" },
		}), { status: 200 }) });
		await primePreparedPayload(resetRuntime, branch, { model: fluxionGpt55 });
		await resetRuntime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		);
		resetRuntime.handlers.get("session_tree")({}, hookContext(branch, { model: fluxionGpt55 }));
		resetRuntime.handlers.get("session_compact")(
			{ compactionEntry: fallbackEntry, fromExtension: false, reason: "threshold", willRetry: false },
			hookContext([...branch, fallbackEntry], { model: fluxionGpt55 }),
		);
		assert.equal(resetRuntime.appendedEntries.length, 0, "stale fallback diagnostics are cleared on tree changes");
	});
});

test("Codex fallback diagnostics redact the resolved account identity exactly", async () => {
	await withFeatureEnabled(async () => {
		const apiKey = token("acct-exact-42");
		const runtime = stubExtension({ fetchFn: async () => new Response(sse([
			{ type: "error", code: "invalid_request", message: "account acct-exact-42 was rejected" },
		], { done: false }), { status: 200 }) });
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch);
		assert.equal(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { auth: { ok: true, apiKey, headers: {} } }),
		), undefined);
		const fallbackEntry = compactionEntry("c1", "u1", { readFiles: [] }, "readable Pi summary");
		runtime.handlers.get("session_compact")(
			{ compactionEntry: fallbackEntry, fromExtension: false, reason: "threshold", willRetry: false },
			hookContext([...branch, fallbackEntry]),
		);
		const persisted = JSON.stringify(runtime.appendedEntries);
		assert.doesNotMatch(persisted, /acct-exact-42/);
		assert.match(persisted, /<redacted>/);
	});
});

test("safe-looking active credentials are rejected from persisted remote output", async () => {
	await withFeatureEnabled(async () => {
		const codexKey = token("acct-exact-42");
		const codexRuntime = stubExtension({ fetchFn: async () => new Response(sse([
			{
				type: "response.output_item.done",
				item: {
					type: "compaction",
					id: "acct-exact-42",
					encrypted_content: "opaque",
					internal_chat_message_metadata_passthrough: { turn_id: "acct-exact-42" },
				},
			},
			{ type: "response.completed", response: { id: "resp-safe", status: "completed" } },
		])) });
		const codexBranch = [userEntry()];
		await primePreparedPayload(codexRuntime, codexBranch);
		assert.equal(await codexRuntime.handlers.get("session_before_compact")(
			compactionEvent(codexBranch),
			hookContext(codexBranch, { auth: { ok: true, apiKey: codexKey, headers: {} } }),
		), undefined);

		const standardRuntime = stubExtension({ fetchFn: async () => standardCompactionResponse({
			id: "mirror-key",
			output: standardCompactionOutput(),
		}) });
		const standardBranch = [userEntry()];
		await primePreparedPayload(standardRuntime, standardBranch, { model: fluxionGpt55 });
		assert.equal(await standardRuntime.handlers.get("session_before_compact")(
			compactionEvent(standardBranch),
			hookContext(standardBranch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		), undefined);
		assert.equal(JSON.stringify([...codexRuntime.appendedEntries, ...standardRuntime.appendedEntries]).includes("acct-exact-42"), false);
		assert.equal(JSON.stringify([...codexRuntime.appendedEntries, ...standardRuntime.appendedEntries]).includes("mirror-key"), false);
	});
});

test("standard 200 JSON errors retry only explicit overload and redact permanent diagnostics", async () => {
	await withFeatureEnabled(async () => {
		const branch = [userEntry()];
		let attempts = 0;
		const delays = [];
		const retryRuntime = stubExtension({
			fetchFn: async () => {
				attempts++;
				if (attempts === 1) {
					return new Response(JSON.stringify({
						error: { code: "slow_down", message: "Bearer should-not-leak" },
					}), { status: 200 });
				}
				return standardCompactionResponse();
			},
			sleepFn: async (milliseconds) => delays.push(milliseconds),
		});
		await primePreparedPayload(retryRuntime, branch, { model: fluxionGpt55 });
		const retried = await retryRuntime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		);
		assert.equal(retried.compaction.details.adapter, "standard-responses-json");
		assert.equal(attempts, 2);
		assert.deepEqual(delays, [REMOTE_COMPACTION_OVERLOAD_RETRY_BASE_DELAY_MS]);

		let permanentAttempts = 0;
		const notices = [];
		const permanentRuntime = stubExtension({ fetchFn: async () => {
			permanentAttempts++;
			return new Response(JSON.stringify({
				error: { code: "invalid_api_key", message: "production endpoint rejected mirror-key" },
			}), { status: 200 });
		} });
		await primePreparedPayload(permanentRuntime, branch, { model: fluxionGpt55 });
		assert.equal(await permanentRuntime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, notices, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		), undefined);
		assert.equal(permanentAttempts, 1);
		assert.doesNotMatch(notices.at(-1).message, /mirror-key/);
		assert.match(notices.at(-1).message, /production endpoint rejected <redacted>/);
	});
});

test("standard checkpoints are exact-model-bound and recursive replacement keeps one active artifact", async () => {
	const first = compactionEntry("c1", null, standardNativeDetails(fluxionGpt55, {
		replacementHistory: standardCompactionOutput({ encrypted: "A" }),
	}));
	const tail = userEntry("u2", "c1", "tail");
	const replay = await reconstructReplayHistory([first, tail], fluxionGpt55);
	assert.equal(countArtifacts(replay), 1);
	assert.match(JSON.stringify(replay), /A|tail/);
	await assert.rejects(() => reconstructReplayHistory([first, tail], fluxionGpt56), /endpoint or model/);
	const xaiCheckpoint = compactionEntry("c3", null, standardNativeDetails(xaiGrok46, {
		replacementHistory: [{ type: "compaction", id: "cmp_xai", encrypted_content: "xai-A" }],
	}));
	const xaiReplay = await reconstructReplayHistory([xaiCheckpoint, tail], xaiGrok46);
	assert.equal(countArtifacts(xaiReplay), 1);
	assert.match(JSON.stringify(xaiReplay), /xai-A|tail/);
	// An xAI checkpoint must not replay on a different standard provider endpoint.
	await assert.rejects(() => reconstructReplayHistory([xaiCheckpoint, tail], fluxionGrok), /endpoint or model/);
	// The same model id on a different mirror endpoint is a distinct identity too.
	const fluxion46Checkpoint = compactionEntry("c4", null, standardNativeDetails(fluxionGrok46, {
		replacementHistory: [{ type: "compaction", id: "cmp_fluxion", encrypted_content: "fluxion-A" }],
	}));
	const fluxion46Replay = await reconstructReplayHistory([fluxion46Checkpoint, tail], fluxionGrok46);
	assert.equal(countArtifacts(fluxion46Replay), 1);
	await assert.rejects(() => reconstructReplayHistory([fluxion46Checkpoint, tail], xaiGrok46), /endpoint or model/);

	const second = compactionEntry("c2", "u2", standardNativeDetails(fluxionGpt55, {
		replacementHistory: standardCompactionOutput({ encrypted: "B" }),
	}));
	const latest = await reconstructReplayHistory([first, tail, second], fluxionGpt55);
	assert.equal(countArtifacts(latest), 1);
	assert.match(JSON.stringify(latest), /B/);
	assert.doesNotMatch(JSON.stringify(latest), /cmp-A|"A"/);
});

test("standard recursive compaction sends checkpoint A plus tail and persists only canonical B", async () => {
	await withFeatureEnabled(async () => {
		const outputA = standardCompactionOutput({ encrypted: "recursive-A" });
		const outputB = standardCompactionOutput({ encrypted: "recursive-B" });
		let nextOutput = outputA;
		const compactBodies = [];
		const runtime = stubExtension({ fetchFn: async (_url, init) => {
			compactBodies.push(JSON.parse(init.body));
			return standardCompactionResponse({ output: nextOutput });
		} });
		const initialBranch = [userEntry("u1", null, "initial")];
		await primePreparedPayload(runtime, initialBranch, { model: fluxionGpt55 });
		const firstResult = await runtime.handlers.get("session_before_compact")(
			compactionEvent(initialBranch),
			hookContext(initialBranch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		);
		const first = compactionEntry("c1", null, firstResult.compaction.details);
		const branch = [first, userEntry("u2", "c1", "recursive tail")];
		nextOutput = outputB;
		await runDecoratedRequest(runtime, { branch, model: fluxionGpt55 });
		const secondResult = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		);
		assert.equal(countArtifacts(compactBodies[1].input), 1);
		assert.match(JSON.stringify(compactBodies[1].input), /recursive-A|recursive tail/);
		assert.deepEqual(secondResult.compaction.details.replacementHistory, outputB);
		assert.doesNotMatch(JSON.stringify(secondResult.compaction.details.replacementHistory), /recursive-A/);
	});
});

test("standard prepared snapshots are invalidated by every session/model lifecycle reset", async () => {
	await withFeatureEnabled(async () => {
		for (const eventName of ["session_start", "session_tree", "model_select", "session_shutdown"]) {
			let remoteFetches = 0;
			const runtime = stubExtension({ fetchFn: async () => {
				remoteFetches++;
				return standardCompactionResponse();
			} });
			const branch = [userEntry()];
			await primePreparedPayload(runtime, branch, { model: fluxionGpt55 });
			await runtime.handlers.get(eventName)({}, hookContext(branch, { model: fluxionGpt55 }));
			const authCalls = [];
			assert.equal(await runtime.handlers.get("session_before_compact")(
				compactionEvent(branch),
				hookContext(branch, { model: fluxionGpt55, authCalls }),
			), undefined, eventName);
			assert.equal(authCalls.length, 0, eventName);
			assert.equal(remoteFetches, 0, eventName);
		}
	});
});

test("standard opaque ownership cancels without a fresh snapshot and after transient exhaustion", async () => {
	await withFeatureEnabled(async () => {
		const branch = [
			compactionEntry("c1", null, standardNativeDetails(fluxionGpt55)),
			userEntry("u2", "c1", "tail"),
		];
		let attempts = 0;
		const runtime = stubExtension({
			fetchFn: async () => {
				attempts++;
				return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503 });
			},
			sleepFn: async () => {},
		});
		const noSnapshotAuth = [];
		assert.deepEqual(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, authCalls: noSnapshotAuth }),
		), { cancel: true });
		assert.equal(noSnapshotAuth.length, 0);
		assert.equal(attempts, 0);

		await primePreparedPayload(runtime, branch, { model: fluxionGpt55 });
		assert.deepEqual(await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { model: fluxionGpt55, auth: { ok: true, apiKey: "mirror-key", headers: {} } }),
		), { cancel: true });
		assert.equal(attempts, REMOTE_COMPACTION_MAX_ATTEMPTS);
	});
});

test("successful native creation uses the canonical URL, exact snapshot payload, and direct encrypted checkpoint", async () => {
	await withFeatureEnabled(async () => {
		let request;
		const notices = [];
		const runtime = stubExtension({ fetchFn: async (url, init) => {
			request = { url, init };
			return compactionResponse();
		} });
		const compactionModel = {
			...model,
			headers: { "X-Delete-Me": "model-default", "x-keep-me": "model-default", "Content-Encoding": "zstd" },
		};
		const branch = [userEntry("u1", null, "secret")];
		await primePreparedPayload(runtime, branch, {
			model: compactionModel,
			downstream: (payload) => ({
				...payload,
				instructions: `${payload.instructions}\n\nlate hostile instruction`,
				late_extension_marker: "preserved",
			}),
		});
		branch.push(assistantEntry("a1", "u1"));
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch, { customInstructions: "focus here" }),
			hookContext(branch, {
				model: compactionModel,
				notices,
				auth: { ok: true, apiKey: token(), headers: { "x-delete-me": null } },
			}),
		);
		assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
		const headers = new Headers(request.init.headers);
		assert.match(headers.get("x-codex-beta-features"), /remote_compaction_v2/);
		assert.equal(headers.get("x-delete-me"), null);
		assert.equal(headers.get("x-keep-me"), "model-default");
		assert.equal(headers.get("content-encoding"), null);
		assert.equal(headers.get("session-id"), "session-123");
		const body = JSON.parse(request.init.body);
		assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
		assert.equal(body.previous_response_id, undefined);
		assert.match(body.instructions, /late hostile instruction/);
		assert.equal(body.late_extension_marker, "preserved");
		assert.equal(result.compaction.summary, SERVER_COMPACTION_SHIM_SUMMARY);
		assert.equal(result.compaction.details.strategy, SERVER_COMPACTION_STRATEGY);
		assert.equal(result.compaction.details.replacementHistory.at(-1).encrypted_content, "opaque");
		assert.equal(result.compaction.usage.cacheRead, 30);
		assert.equal(notices.length, 1);
		assert.match(notices[0].message, /ignores custom \/compact guidance/);
	});
});

test("lifecycle reset revokes an in-flight native compaction lease", async () => {
	await withFeatureEnabled(async () => {
		const entered = createDeferred();
		const release = createDeferred();
		const runtime = stubExtension({ fetchFn: async () => {
			entered.resolve();
			await release.promise;
			return compactionResponse({ encrypted: "stale" });
		} });
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch);
		const pending = runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		await entered.promise;
		runtime.handlers.get("session_tree")({}, hookContext(branch));
		release.resolve();
		assert.deepEqual(await pending, { cancel: true });
		assert.equal(runtime.appendedEntries.length, 0);
	});
});

test("lifecycle reset revokes a native result while later compact handlers are still pending", async () => {
	await withFeatureEnabled(async () => {
		const runtime = stubExtension();
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch);
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		assert.ok(result.compaction);
		runtime.handlers.get("model_select")({}, hookContext(branch));
		assert.deepEqual(result, { cancel: true });

		const branchRuntime = stubExtension();
		const growingBranch = [userEntry()];
		await primePreparedPayload(branchRuntime, growingBranch);
		const growingResult = await branchRuntime.handlers.get("session_before_compact")(
			compactionEvent(growingBranch),
			hookContext(growingBranch),
		);
		growingBranch.push(assistantEntry("a-after-handler", "u1"));
		assert.equal(growingResult.cancel, true);
		assert.equal(growingResult.compaction, undefined);
	});
});

test("same-branch growth and a new provider request revoke an in-flight native compaction", async () => {
	await withFeatureEnabled(async () => {
		for (const revoke of [
			async (_runtime, branch) => branch.push(assistantEntry("a-late", branch.at(-1).id)),
			async (runtime, branch) => runDecoratedRequest(runtime, { branch }),
		]) {
			const entered = createDeferred();
			const release = createDeferred();
			const runtime = stubExtension({ fetchFn: async () => {
				entered.resolve();
				await release.promise;
				return compactionResponse({ encrypted: "stale-linear-result" });
			} });
			const branch = [userEntry()];
			await primePreparedPayload(runtime, branch);
			const pending = runtime.handlers.get("session_before_compact")(
				compactionEvent(branch),
				hookContext(branch),
			);
			await entered.promise;
			await revoke(runtime, branch);
			release.resolve();
			assert.deepEqual(await pending, { cancel: true });
		}
	});
});

test("a newer native compaction lease supersedes an overlapping older attempt", async () => {
	await withFeatureEnabled(async () => {
		const entered = [createDeferred(), createDeferred()];
		const release = [createDeferred(), createDeferred()];
		let calls = 0;
		const runtime = stubExtension({ fetchFn: async () => {
			const index = calls++;
			entered[index].resolve();
			await release[index].promise;
			return compactionResponse({ encrypted: index === 0 ? "older" : "newer" });
		} });
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch);
		const older = runtime.handlers.get("session_before_compact")(compactionEvent(branch), hookContext(branch));
		await entered[0].promise;
		const newer = runtime.handlers.get("session_before_compact")(compactionEvent(branch), hookContext(branch));
		await entered[1].promise;
		release[1].resolve();
		const newerResult = await newer;
		assert.equal(newerResult.compaction.details.replacementHistory.at(-1).encrypted_content, "newer");
		release[0].resolve();
		assert.deepEqual(await older, { cancel: true });
		assert.equal(calls, 2);
	});
});

test("Codex cache-retention none remains on the sessionless direct compaction lane", async () => {
	await withFeatureEnabled(async () => {
		let request;
		const runtime = stubExtension({ fetchFn: async (_url, init) => {
			request = init;
			return compactionResponse({ encrypted: "no-cache" });
		} });
		const branch = [userEntry()];
		const normal = await primePreparedPayload(runtime, branch, { cacheRetention: "none" });
		assert.equal(normal.sentHeaders.get("session-id"), null);
		assert.equal(normal.sentHeaders.get("x-client-request-id"), null);
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		assert.equal(result.compaction.details.responseId, "resp-no-cache");
		const headers = new Headers(request.headers);
		assert.equal(headers.get("session-id"), null);
		assert.equal(headers.get("x-client-request-id"), null);
	});
});

test("Codex snapshots retain the cache lane copied into the actual provider options", async () => {
	await withFeatureEnabled(async () => {
		let directRequest;
		const runtime = stubExtension({ fetchFn: async (_url, init) => {
			directRequest = init;
			return compactionResponse({ encrypted: "stable-cache-lane" });
		} });
		const branch = [userEntry()];
		const provider = runtime.providers.get("openai-codex");
		let normalHeaders;
		const mutableOptions = {
			apiKey: token(),
			sessionId: "session-123",
			transport: "sse",
			fetch: async (_url, init) => {
				normalHeaders = new Headers(init.headers);
				return normalResponse();
			},
			onPayload: async (payload) => {
				const rewritten = await runtime.handlers.get("before_provider_request")({ payload }, hookContext(branch));
				mutableOptions.cacheRetention = "none";
				return rewritten;
			},
		};
		await drain(provider.streamSimple(model, providerContextFromBranch(branch), mutableOptions));
		assert.equal(normalHeaders.get("session-id"), "session-123");
		const result = await runtime.handlers.get("session_before_compact")(compactionEvent(branch), hookContext(branch));
		assert.ok(result.compaction);
		assert.equal(new Headers(directRequest.headers).get("session-id"), "session-123");
	});
});

test("remote compaction retries only bounded transient failures and preserves one logical request body", async () => {
	await withFeatureEnabled(async () => {
		const calls = [];
		const delays = [];
		const transientError = new Response(sse([
			{ type: "error", code: "server_is_overloaded", message: "temporarily busy" },
			{ type: "response.failed", response: { error: { code: "server_is_overloaded", message: "temporarily busy" } } },
		], { done: false, namedEvents: true }), { status: 200, headers: { "content-type": "text/event-stream" } });
		const runtime = stubExtension({
			fetchFn: async (_url, init) => {
				calls.push(JSON.parse(init.body));
				if (calls.length === 1) return transientError;
				if (calls.length === 2) return new Response(JSON.stringify({ error: { message: "gateway busy" } }), {
					status: 503,
					statusText: "Service Unavailable",
				});
				return compactionResponse({ encrypted: "after-retry" });
			},
			sleepFn: async (milliseconds, signal) => {
				assert.equal(signal.aborted, false);
				delays.push(milliseconds);
			},
		});
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch);
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		assert.equal(calls.length, REMOTE_COMPACTION_MAX_ATTEMPTS);
		assert.deepEqual(delays, [REMOTE_COMPACTION_OVERLOAD_RETRY_BASE_DELAY_MS, REMOTE_COMPACTION_RETRY_BASE_DELAY_MS * 2]);
		assert.equal(calls.every((body) => JSON.stringify(body) === JSON.stringify(calls[0])), true);
		assert.equal(result.compaction.details.replacementHistory.at(-1).encrypted_content, "after-retry");

		let incompleteAttempts = 0;
		const incompleteDelays = [];
		const incompleteRuntime = stubExtension({
			fetchFn: async () => {
				incompleteAttempts++;
				if (incompleteAttempts === 1) {
					return new Response(sse([{ type: "response.in_progress", response: { id: "cut-off" } }], {
						done: false,
						namedEvents: true,
					}), { status: 200 });
				}
				return compactionResponse({ encrypted: "after-incomplete" });
			},
			sleepFn: async (milliseconds) => incompleteDelays.push(milliseconds),
		});
		await primePreparedPayload(incompleteRuntime, branch);
		const incompleteResult = await incompleteRuntime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		assert.equal(incompleteAttempts, 2);
		assert.deepEqual(incompleteDelays, [REMOTE_COMPACTION_RETRY_BASE_DELAY_MS]);
		assert.equal(incompleteResult.compaction.details.replacementHistory.at(-1).encrypted_content, "after-incomplete");

		let disconnectedAttempts = 0;
		const disconnectedRuntime = stubExtension({
			fetchFn: async () => {
				disconnectedAttempts++;
				if (disconnectedAttempts > 1) return compactionResponse({ encrypted: "after-disconnect" });
				return new Response(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("event: response.in_progress\ndata: {\"type\":\"response.in_progress\"}\n\n"));
						controller.error(new Error("socket reset"));
					},
				}), { status: 200 });
			},
			sleepFn: async () => {},
		});
		await primePreparedPayload(disconnectedRuntime, branch);
		const disconnectedResult = await disconnectedRuntime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		assert.equal(disconnectedAttempts, 2);
		assert.equal(disconnectedResult.compaction.details.replacementHistory.at(-1).encrypted_content, "after-disconnect");

		for (const response of [
			new Response(JSON.stringify({ error: { message: "bad credentials" } }), { status: 401, statusText: "Unauthorized" }),
			new Response("data: {broken}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
			new Response(null, { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
		]) {
			let attempts = 0;
			const permanentRuntime = stubExtension({ fetchFn: async () => {
				attempts++;
				return response;
			} });
			await primePreparedPayload(permanentRuntime, branch);
			assert.equal(await permanentRuntime.handlers.get("session_before_compact")(
				compactionEvent(branch),
				hookContext(branch),
			), undefined);
			assert.equal(attempts, 1);
		}
	});
});

test("native failure before ownership remains fail-open and arms no summarizer replay", async () => {
	await withFeatureEnabled(async () => {
		const notices = [];
		const authCalls = [];
		const runtime = stubExtension({ fetchFn: async () => {
			throw new Error("must not fetch without a snapshot");
		} });
		const branch = [userEntry()];
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { notices, authCalls }),
		);
		assert.equal(result, undefined);
		assert.equal(authCalls.length, 0, "snapshot validation precedes extension auth");
		assert.match(notices[0].message, /Pi compaction will run/);
		const summary = await runDecoratedRequest(runtime, {
			branch,
			context: summaryProviderContext("plain fallback"),
			sessionId: "fresh-routing-id",
			withoutOnPayload: true,
		});
		assert.equal(countArtifacts(summary.sentBody.input), 0);
	});
});

test("direct compaction requires a resolved API key even when auth headers exist", async () => {
	await withFeatureEnabled(async () => {
		let fetches = 0;
		const runtime = stubExtension({ fetchFn: async () => {
			fetches++;
			return compactionResponse();
		} });
		const freshBranch = [userEntry()];
		await primePreparedPayload(runtime, freshBranch);
		assert.equal(await runtime.handlers.get("session_before_compact")(
			compactionEvent(freshBranch),
			hookContext(freshBranch, { auth: {
				ok: true,
				headers: { authorization: "Bearer header-only" },
			} }),
		), undefined);
		assert.equal(fetches, 0);

		const ownedBranch = [
			compactionEntry("c1", null, nativeDetails()),
			userEntry("u2", "c1", "tail"),
		];
		await primePreparedPayload(runtime, ownedBranch);
		assert.deepEqual(await runtime.handlers.get("session_before_compact")(
			compactionEvent(ownedBranch),
			hookContext(ownedBranch, { auth: {
				ok: true,
				headers: { authorization: "Bearer header-only" },
			} }),
		), { cancel: true });
		assert.equal(fetches, 0);
	});
});

test("opaque checkpoint failure cancels compaction instead of sending an uncorrelated Pi shim", async () => {
	await withFeatureEnabled(async () => {
		const runtime = stubExtension();
		const branch = [compactionEntry("c1", null, nativeDetails()), userEntry("u2", "c1", "tail")];
		const notices = [];
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch, { notices }),
		);
		assert.deepEqual(result, { cancel: true });
		assert.match(notices.at(-1).message, /readable Pi fallback is unsafe/);
	});
});

test("malformed and wrong-endpoint current checkpoints cancel native compaction and block replay", async () => {
	await withFeatureEnabled(async () => {
		for (const [details, activeModel] of [
			[{ strategy: SERVER_COMPACTION_STRATEGY }, model],
			[nativeDetails(), { ...model, baseUrl: "https://chatgpt.com/other" }],
		]) {
			const runtime = stubExtension();
			const branch = [compactionEntry("c1", null, details)];
			const notices = [];
			assert.deepEqual(await runtime.handlers.get("session_before_compact")(
				compactionEvent(branch),
				hookContext(branch, { model: activeModel, notices }),
			), { cancel: true });
			const result = await runDecoratedRequest(runtime, {
				branch,
				model: activeModel,
				context: summaryProviderContext("must block"),
			});
			assert.equal(result.fetchCalls, 0);
			assert.equal(result.events.at(-1).type, "error");
			assert.ok(notices.length > 0);
		}
	});
});

test("snapshot session, model, endpoint, and branch failures occur before extension auth or remote fetch", async () => {
	await withFeatureEnabled(async () => {
		for (const variant of ["session", "model", "branch"]) {
			let remoteFetches = 0;
			const runtime = stubExtension({ fetchFn: async () => {
				remoteFetches++;
				return compactionResponse();
			} });
			const originalBranch = [userEntry("u1", null, "original")];
			await primePreparedPayload(runtime, originalBranch);
			let activeBranch = originalBranch;
			let activeModel = model;
			let sessionId = "session-123";
			if (variant === "session") sessionId = "other-session";
			if (variant === "model") activeModel = { ...model, id: "gpt-next" };
			if (variant === "branch") activeBranch = [userEntry("other", null, "other branch")];
			const authCalls = [];
			const result = await runtime.handlers.get("session_before_compact")(
				compactionEvent(activeBranch),
				hookContext(activeBranch, { model: activeModel, sessionId, authCalls }),
			);
			assert.equal(result, undefined, variant);
			assert.equal(authCalls.length, 0, variant);
			assert.equal(remoteFetches, 0, variant);
		}
	});
});

test("abort before and during remote fetch returns cancellation without native persistence", async () => {
	await withFeatureEnabled(async () => {
		{
			let remoteFetches = 0;
			const runtime = stubExtension({ fetchFn: async () => {
				remoteFetches++;
				return compactionResponse();
			} });
			const branch = [userEntry()];
			await primePreparedPayload(runtime, branch);
			const controller = new AbortController();
			controller.abort();
			const result = await runtime.handlers.get("session_before_compact")(
				compactionEvent(branch, { signal: controller.signal }),
				hookContext(branch),
			);
			assert.deepEqual(result, { cancel: true });
			assert.equal(remoteFetches, 0);
		}
		{
			const started = createDeferred();
			const runtime = stubExtension({ fetchFn: async (_url, init) => {
				started.resolve();
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
				});
			} });
			const branch = [userEntry()];
			await primePreparedPayload(runtime, branch);
			const controller = new AbortController();
			const pending = runtime.handlers.get("session_before_compact")(
				compactionEvent(branch, { signal: controller.signal }),
				hookContext(branch),
			);
			await started.promise;
			controller.abort();
			assert.deepEqual(await pending, { cancel: true });
		}
		{
			const backoffStarted = createDeferred();
			let fetches = 0;
			const runtime = stubExtension({
				fetchFn: async () => {
					fetches++;
					return new Response(sse([
						{ type: "error", code: "slow_down", message: "retry later" },
					], { done: false, namedEvents: true }), { status: 200 });
				},
				sleepFn: async (_milliseconds, signal) => {
					backoffStarted.resolve();
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			});
			const branch = [userEntry()];
			await primePreparedPayload(runtime, branch);
			const controller = new AbortController();
			const pending = runtime.handlers.get("session_before_compact")(
				compactionEvent(branch, { signal: controller.signal }),
				hookContext(branch),
			);
			await backoffStarted.promise;
			controller.abort();
			assert.deepEqual(await pending, { cancel: true });
			assert.equal(fetches, 1);
		}
	});
});

test("session_compact resolves the newest same-shim checkpoint and renders all requested UI at narrow width", () => {
	const runtime = stubExtension();
	const firstUsage = usage({ input: 10, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 13 });
	const secondUsage = usage({ input: 80, output: 9, cacheRead: 20, cacheWrite: 0, totalTokens: 109 });
	const first = compactionEntry("c1", null, nativeDetails({ usage: firstUsage }));
	const between = userEntry("u2", "c1", "later");
	const second = compactionEntry("c2", "u2", nativeDetails({ replacementHistory: [
		{ type: "compaction", encrypted_content: "newest" },
	], usage: secondUsage }));
	const branch = [first, between, second];
	runtime.handlers.get("session_compact")(
		{ compactionEntry: first, fromExtension: true, reason: "manual", willRetry: false },
		hookContext(branch),
	);
	assert.equal(runtime.appendedEntries.length, 1);
	assert.deepEqual(Object.keys(runtime.appendedEntries[0].data), ["usage"]);
	assert.deepEqual(runtime.appendedEntries[0].data.usage, secondUsage);
	const renderer = runtime.renderers.get(SERVER_COMPACTION_DISPLAY_ENTRY_TYPE);
	const lines = renderer({ data: runtime.appendedEntries[0].data }, { expanded: false }, theme()).render(36);
	for (const line of lines) assert.ok(line.length <= 36, line);
	const rendered = lines.join("\n").replace(/\s+/g, " ");
	assert.match(rendered, /\[compaction\]/);
	assert.match(rendered, /opaque compaction result is not human-readable in Pi/);
	assert.match(rendered, /do not turn Responses compaction off or switch providers mid-session/);
	assert.match(rendered, /Compaction V2 · input 100 · cache read 20 \(20\.0%\).*output 9/);
	assert.equal(SERVER_COMPACTION_DISPLAY_TEXT.includes("human-readable in Pi"), true);
});

test("persisted native details recursively contain no auth, header, or provider-error material", async () => {
	await withFeatureEnabled(async () => {
		const runtime = stubExtension({ fetchFn: async () => compactionResponse({ encrypted: "checkpoint-ciphertext" }) });
		const branch = [userEntry()];
		await primePreparedPayload(runtime, branch);
		const result = await runtime.handlers.get("session_before_compact")(
			compactionEvent(branch),
			hookContext(branch),
		);
		const forbiddenKeys = /^(authorization|headers?|chatgpt-account-id|account(?:[_-]id)?|api[_-]?key|token|error(?:message)?)$/i;
		const visit = (value) => {
			if (Array.isArray(value)) return value.forEach(visit);
			if (!value || typeof value !== "object") {
				if (typeof value === "string") assert.doesNotMatch(value, /Bearer\s|\beyJ[A-Za-z0-9_-]+\./);
				return;
			}
			for (const [key, child] of Object.entries(value)) {
				assert.doesNotMatch(key, forbiddenKeys);
				visit(child);
			}
		};
		visit(result.compaction.details);
		assert.equal(result.compaction.details.replacementHistory.at(-1).encrypted_content, "checkpoint-ciphertext");
	});
});
