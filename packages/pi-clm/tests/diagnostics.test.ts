import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { comparePayload, fingerprintPayload, hashJson, MAX_COMPARED_ITEMS, payloadSummary, routingHeaderHashes } from "../src/diagnostic-fingerprint.ts";
import { DiagnosticSession, DIAGNOSTIC_SINK_EVENT, installDiagnostics } from "../src/diagnostics.ts";

const payload = (text: string) => ({ model: "offline", instructions: "SECRET_INSTRUCTIONS", tools: [{ name: "tool", description: "SECRET_SCHEMA" }], prompt_cache_key: "SECRET_CACHE_KEY", input: [{ type: "message", role: "user", content: text }, { type: "reasoning", encrypted_content: "SECRET_CIPHERTEXT" }] });
const who = { provider: "openai-codex", api: "openai-codex-responses", model: "offline" };
const rows = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
function temporary(run: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(), "clm-diag-unit-")); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }

test("fingerprints report append-only prefixes and config/first-item changes without plaintext", () => {
  const first = fingerprintPayload(payload("SECRET_PROMPT"));
  const next = fingerprintPayload({ ...payload("SECRET_PROMPT"), input: [...payload("SECRET_PROMPT").input, { type: "message", role: "assistant", content: "SECRET_REPLY" }] });
  const comparison = comparePayload(first, next);
  assert.ok(comparison.previousAvailable);
  assert.equal(comparison.previousInputIsPrefix, true);
  assert.equal(comparison.commonInputItems, 2);
  assert.equal(comparison.configChanged, false);
  assert.ok(comparison.commonInputBytes! > 0);
  const changed = comparePayload(first, fingerprintPayload({ ...payload("SECRET_CHANGED"), service_tier: "priority" }));
  assert.ok(changed.previousAvailable);
  assert.equal(changed.commonInputItems, 0);
  assert.deepEqual(changed.changedConfigFields, ["service_tier"]);
  assert.ok(changed.firstDifference?.changedFields.includes("content"));
  assert.doesNotMatch(JSON.stringify({ summary: payloadSummary(first), comparison, changed }), /SECRET_/);
});

test("unknown labels and fields stay hashed; capped comparisons never claim a complete prefix", () => {
  const fp = fingerprintPayload({ unknownSecretField: "SECRET_VALUE", input: Array.from({ length: MAX_COMPARED_ITEMS + 1 }, () => ({ type: "SECRET_TYPE", role: "SECRET_ROLE", content: "SECRET_CONTENT" })) });
  const same = comparePayload(fp, fp);
  assert.ok(same.previousAvailable);
  assert.equal(fp.items.length, MAX_COMPARED_ITEMS);
  assert.equal(same.comparisonTruncated, true);
  assert.equal(same.previousInputIsPrefix, false);
  assert.doesNotMatch(JSON.stringify(fp), /SECRET_|unknownSecretField/);
  assert.throws(() => fingerprintPayload(null));
});

test("routing headers exclude credentials and include hashed account routing", () => {
  const result = routingHeaderHashes({ Authorization: "SECRET_AUTH", Cookie: "SECRET_COOKIE", "ChatGPT-Account-Id": "SECRET_ACCOUNT", "x-request-id": "SECRET_REQUEST", "arbitrary-secret": "SECRET_UNKNOWN" });
  assert.deepEqual(Object.keys(result), ["chatgpt-account-id", "x-request-id"]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

test("trace uses restricted permissions, correlates terminal request and usage, and never leaks bodies", () => temporary(dir => {
  const trace = new DiagnosticSession("test-session", dir);
  const input = payload("SECRET_PROMPT");
  trace.capture("provider-hook", input, who, { revision: 2, enabled: true, sourceMessageCount: 304, projectedMessageCount: 42 });
  trace.capture("terminal", input, who, undefined, hashJson(input), "sse", hashJson("SECRET_BASE_URL"));
  trace.providerEvent({ type: "response.created", response: { id: "SECRET_RESPONSE_ID" } }, who);
  trace.providerEvent({ type: "response.completed", response: { id: "SECRET_RESPONSE_ID", service_tier: "default", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 128 }, output_tokens: 10 } } }, who);
  trace.close();
  assert.equal(statSync(trace.filePath).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "test-session")).mode & 0o777, 0o700);
  const log = rows(trace.filePath);
  const requests = log.filter(row => row.event === "request");
  assert.equal(requests[1].requestId, requests[0].requestId);
  assert.equal(requests[1].pipelineCorrelation, "unique-hash-match");
  const usage = log.find(row => row.event === "response_usage");
  assert.equal(usage.requestId, requests[0].requestId);
  assert.equal(usage.cachedTokens, 128);
  assert.equal(usage.cacheHitRatio, 0.128);
  assert.equal(usage.reportedServiceTier, "default");
  assert.doesNotMatch(readFileSync(trace.filePath, "utf8"), /SECRET_/);
}));

test("duplicate pending payloads and abandoned requests do not invent unique correlation", () => temporary(dir => {
  const trace = new DiagnosticSession("test", dir);
  const input = payload("x");
  trace.capture("provider-hook", input, who);
  trace.capture("provider-hook", input, who);
  trace.capture("terminal", input, who, undefined, hashJson(input));
  trace.providerEvent({ type: "response.created", response: { id: "response" } }, who);
  const log = rows(trace.filePath);
  assert.equal(log.at(-2).pipelineCorrelation, "ambiguous");
  assert.equal(log.at(-1).correlation, "ambiguous-or-unmatched");
  for (let i = 0; i < 40; i++) trace.capture("provider-hook", payload(String(i)), who);
  trace.providerEvent({ type: "response.created", response: { id: "bounded" } }, who);
  assert.equal(rows(trace.filePath).at(-1).candidateCount, 32);
  trace.close();
}));

test("trace size limit and invalid payload errors are bounded and sanitized", () => temporary(dir => {
  const trace = new DiagnosticSession("../../escape", dir, 1000);
  trace.capture("provider-hook", { input: [1n] }, who);
  assert.equal(rows(trace.filePath).at(-1).code, "unsupported_payload");
  for (let i = 0; i < 10; i++) trace.write({ event: "limit", value: "x".repeat(400) });
  assert.equal(trace.truncated, true);
  assert.ok(statSync(trace.filePath).size <= 1000);
  assert.ok(trace.filePath.startsWith(dir));
  trace.close();
  trace.write({ event: "closed" });
}));

function harness() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const notices: string[] = [];
  const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, command: unknown) => commands.set(name, command), events: { on: (name: string, fn: Function) => { listeners.set(name, fn); return () => { listeners.delete(name); }; } } } as unknown as ExtensionAPI;
  const ctx = { model: { ...who, id: who.model }, sessionManager: { getSessionId: () => "harness", getBranch: () => [] }, ui: { notify: (message: string) => notices.push(message) } };
  return { pi, handlers, commands, listeners, notices, ctx };
}

test("disabled diagnostics write nothing; on/off command and session restart clean up the sink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clm-diag-hook-"));
  try {
    const h = harness();
    installDiagnostics(h.pi, { enabled: false, directory: dir });
    h.handlers.get("session_start")!({}, h.ctx);
    assert.deepEqual(readdirSync(dir), []);
    await h.commands.get("clm-trace").handler("on", h.ctx);
    assert.ok(h.listeners.has(DIAGNOSTIC_SINK_EVENT));
    const input = payload("SECRET_TEXT");
    assert.equal(h.handlers.get("before_provider_request")!({ payload: input }, h.ctx), undefined);
    assert.deepEqual(input, payload("SECRET_TEXT"));
    const sinks: Function[] = [];
    const reply = (value: Function) => { sinks.push(value); };
    h.listeners.get(DIAGNOSTIC_SINK_EVENT)!({ version: 1, sessionId: "foreign", reply });
    assert.equal(sinks.length, 0);
    h.listeners.get(DIAGNOSTIC_SINK_EVENT)!({ version: 1, sessionId: "harness", reply });
    assert.equal(sinks.length, 1);
    sinks[0]({ version: 2, sessionId: "harness", payload: input });
    sinks[0]({ version: 1, sessionId: "harness", payload: input, pipelinePayloadHash: hashJson(input), ...who });
    h.handlers.get("session_start")!({}, h.ctx);
    await h.commands.get("clm-trace").handler("off", h.ctx);
    assert.equal(h.listeners.size, 0);
    assert.equal(readdirSync(join(dir, "harness")).length, 2);
    h.handlers.get("session_shutdown")!({}, h.ctx);
    assert.match(h.notices.at(-1)!, /off/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("trace initialization failure does not block request hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clm-diag-failure-"));
  try {
    const notDirectory = join(dir, "file");
    writeFileSync(notDirectory, "not a directory");
    const h = harness();
    installDiagnostics(h.pi, { enabled: true, directory: notDirectory });
    assert.doesNotThrow(() => h.handlers.get("session_start")!({}, h.ctx));
    assert.equal(h.handlers.get("before_provider_request")!({ payload: payload("SECRET") }, h.ctx), undefined);
    await h.commands.get("clm-trace").handler("status", h.ctx);
    assert.match(h.notices.at(-1)!, /trace_initialization_failed/);
    assert.doesNotMatch(h.notices.at(-1)!, /ENOTDIR/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
