/**
 * Dogfood stage 1: real-token protocol round trip against the live ChatGPT
 * Codex compaction endpoint (via Tailscale exit node th001-gateway2).
 *
 *  1. Capture the exact provider payload shape using the module's capture
 *     technique (local only; onPayload throws before any transport).
 *  2. Build the compaction request (input + compaction_trigger).
 *  3. POST to https://chatgpt.com/backend-api/codex/responses with the real
 *     OAuth token.
 *  4. Parse the SSE stream, build the replay history, round-trip the
 *     checkpoint details, and (if --replay) send one minimal replay request
 *     to prove the backend accepts the opaque artifact as input.
 *
 * Usage: node --experimental-strip-types dogfood1.mjs [--replay]
 */
import { readFileSync } from "node:fs";
import {
  buildCodexCompactionHeaders,
  buildPreparedCompactionRequest,
  buildReplacementHistory,
  extractServerCompactionDetails,
  isSupportedCodexModel,
  parseCompactionSse,
  requestServerCompaction,
  retainRecentUserItems,
} from "../../openai-server-compaction.ts";
import { streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai";

const cred = JSON.parse(readFileSync("/tmp/pa-dogfood-cred.json", "utf8"));
const token = cred.access;

const model = {
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.6-sol",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 272_000,
  maxTokens: 128_000,
  thinkingLevelMap: { off: "none", medium: "medium", max: "xhigh" },
  cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
};

const NONCE = `dogfood-nonce-${Date.now()}`;

// 1. Capture the real payload shape (no network: onPayload throws before fetch).
function capturePayload(messages) {
  let captured;
  const stream = streamSimpleOpenAICodexResponses(
    { ...model, baseUrl: "http://127.0.0.1:1" },
    { systemPrompt: "You are a helpful assistant.", messages, tools: [] },
    {
      apiKey: token,
      signal: new AbortController().signal,
      sessionId: `dogfood-sess-${Date.now()}`,
      onPayload: (payload) => {
        captured = payload;
        throw new Error("captured");
      },
    },
  );
  return (async () => {
    for await (const _ of stream) { /* capture already happened */ }
    if (!captured) throw new Error("no payload captured");
    return captured;
  })();
}

const messages = [
  { role: "user", content: [{ type: "text", text: `Remember this nonce exactly: ${NONCE}. Also list the first five prime numbers.` }], timestamp: Date.now() },
  { role: "assistant", content: [{ type: "text", text: "Understood. The first five prime numbers are 2, 3, 5, 7, 11." }], timestamp: Date.now() },
  { role: "user", content: [{ type: "text", text: "Great, keep going with the next five." }], timestamp: Date.now() },
];

const prepared = await capturePayload(messages);
console.log("captured payload model:", prepared.model);
console.log("captured input items:", prepared.input.length, "| first item type:", prepared.input[0]?.type);
console.log("captured has instructions:", typeof prepared.instructions === "string" ? "yes" : "no");

if (!isSupportedCodexModel(model)) throw new Error("model not allowlisted");

// Tail items = entries appended after the snapshot leaf (simulated).
const tailInput = [{ type: "message", role: "user", content: [{ type: "input_text", text: "tail message after checkpoint" }] }];
const { body, compactedInput } = buildPreparedCompactionRequest(prepared, tailInput);
console.log("compaction body input:", body.input.length, "items; last:", JSON.stringify(body.input.at(-1)));

// 2+3+4. Real compaction request.
const sessionId = `dogfood-sess-${Date.now()}`;
const result = await requestServerCompaction({
  adapter: "codex-trigger-sse",
  url: "https://chatgpt.com/backend-api/codex/responses",
  model,
  apiKey: token,
  sessionId,
  body,
  compactedInput,
  signal: new AbortController().signal,
  fetchFn: globalThis.fetch,
  sleepFn: async (ms) => { await new Promise((r) => setTimeout(r, ms)); },
});
console.log("\n== REAL COMPACTION SUCCEEDED ==");
console.log("responseId:", result.responseId);
console.log("usage:", JSON.stringify(result.usage));
const history = result.replacementHistory;
console.log("replacementHistory items:", history.length);
console.log("artifact type:", history.at(-1)?.type);
console.log("artifact id:", history.at(-1)?.id);
console.log("artifact has encrypted_content:", typeof history.at(-1)?.encrypted_content === "string" && history.at(-1).encrypted_content.length > 0);
console.log("artifact metadata:", JSON.stringify(history.at(-1)?.internal_chat_message_metadata_passthrough));
console.log("retained user texts:", JSON.stringify(history.slice(0, -1).flatMap((i) => (i.content ?? []).map((p) => p.text))));

// Round-trip the persisted details.
const details = {
  strategy: "openai-responses-compaction-v2",
  adapter: "codex-trigger-sse",
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: model.id,
  baseUrl: "https://chatgpt.com/backend-api",
  replacementHistory: history,
  createdAt: new Date().toISOString(),
  responseId: result.responseId,
  usage: result.usage,
};
const reparsed = extractServerCompactionDetails(details);
console.log("\ndetails round-trip:", reparsed ? "OK" : "FAILED");
console.log("round-trip artifact id:", reparsed?.replacementHistory.at(-1)?.id);

// Rebuild a replay payload the same way before_provider_request would.
const replayPayload = { ...prepared, input: JSON.parse(JSON.stringify(history)) };
delete replayPayload.previous_response_id;
console.log("\nreplay payload input items:", replayPayload.input.length);

// Optional: prove the backend accepts the opaque artifact as input.
const replay = process.argv.includes("--replay");
if (replay) {
  console.log("\n-- sending replay request to prove backend acceptance --");
  const stream = streamSimpleOpenAICodexResponses(
    model,
    { systemPrompt: "You are a helpful assistant.", messages: [], tools: [] },
    {
      apiKey: token,
      signal: new AbortController().signal,
      sessionId: `dogfood-replay-${Date.now()}`,
      transport: "sse",
      onPayload: () => { /* keep original payload? we need to replace input */ },
    },
  );
  // Simpler: raw fetch with the replayed body (stream:false, tiny max tokens).
  const replayBody = { ...prepared, input: history, stream: false, max_output_tokens: 32 };
  delete replayBody.previous_response_id;
  const headers = buildCodexCompactionHeaders({ apiKey: token, sessionId });
  const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(replayBody),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  console.log("replay HTTP:", response.status);
  if (!response.ok) {
    console.log("replay rejected:", text.slice(0, 500));
  } else {
    console.log("replay accepted; first 300 chars:", text.slice(0, 300));
  }
}
console.log("\nNONCE used:", NONCE);
