/**
 * Dogfood stage 2: prove opaque-artifact fidelity against the live backend.
 *
 * The secret nonce is placed ONLY in an assistant message. User items are
 * retained in plaintext, so after compaction the nonce exists only inside the
 * encrypted artifact. A replay request (retained user items + artifact + a new
 * question) must still recall the nonce — proving the backend decrypts and
 * honors the compaction artifact as authoritative context.
 *
 * Usage: node --experimental-strip-types tests/py/dogfood2.mjs
 */
import { readFileSync } from "node:fs";
import {
  buildPreparedCompactionRequest,
  requestServerCompaction,
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

const SECRET = `secret-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function capturePayload(messages) {
  let captured;
  const stream = streamSimpleOpenAICodexResponses(
    { ...model, baseUrl: "http://127.0.0.1:1" },
    { systemPrompt: "You are a helpful assistant.", messages, tools: [] },
    {
      apiKey: token,
      signal: new AbortController().signal,
      sessionId: `dogfood2-sess-${Date.now()}`,
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

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      const data = dataLines.join("\n");
      if (data && data !== "[DONE]") {
        try { events.push(JSON.parse(data)); } catch { /* ignore */ }
      }
    }
  }
  return events;
}

// ---- 1. conversation where the secret lives ONLY in an assistant message ----
const messages = [
  { role: "user", content: [{ type: "text", text: "Tell me a secret passphrase and then we will move on." }], timestamp: Date.now() },
  { role: "assistant", content: [{ type: "text", text: `The secret passphrase is ${SECRET}. Keep it in mind; I will not repeat it.` }], timestamp: Date.now() },
  { role: "user", content: [{ type: "text", text: "Got it. Now let's talk about something else entirely." }], timestamp: Date.now() },
];
const prepared = await capturePayload(messages);
const sessionId = `dogfood2-sess-${Date.now()}`;
const tailInput = [];
const { body, compactedInput } = buildPreparedCompactionRequest(prepared, tailInput);

const compacted = await requestServerCompaction({
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
console.log("== compaction OK ==");
console.log("artifact id:", compacted.replacementHistory.at(-1)?.id);
const plaintext = JSON.stringify(compacted.replacementHistory);
console.log("secret leaked into plaintext replay history:", plaintext.includes(SECRET));

// ---- 2. replay: retained items + artifact + a fresh question ----
const replayInput = [
  ...JSON.parse(JSON.stringify(compacted.replacementHistory)),
  { type: "message", role: "user", content: [{ type: "input_text", text: "What was the secret passphrase from our earlier conversation?" }] },
];
const replayBody = {
  model: model.id,
  store: false,
  stream: true,
  instructions: "You are a helpful assistant.",
  input: replayInput,
  text: { verbosity: "low" },
};
const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": cred.accountId,
    originator: "pi",
    "user-agent": "pi (dogfood)",
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    session_id: `dogfood2-replay-${Date.now()}`,
  },
  body: JSON.stringify(replayBody),
  signal: AbortSignal.timeout(180_000),
});
console.log("replay HTTP:", response.status);
if (!response.ok) {
  console.log("replay rejected:", (await response.text()).slice(0, 400));
  process.exit(1);
}
const events = await readSse(response);
const textParts = [];
for (const event of events) {
  if (event.type === "response.output_text.delta") textParts.push(event.delta ?? "");
  if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
    for (const item of event.response.output) {
      if (item.type === "message") {
        for (const part of item.content ?? []) if (part.type === "output_text") textParts.push(part.text ?? "");
      }
    }
  }
}
const answer = textParts.join("");
console.log("replay answer:", JSON.stringify(answer.slice(0, 400)));
console.log("SECRET:", SECRET);
console.log("recalled via artifact:", answer.includes(SECRET));
