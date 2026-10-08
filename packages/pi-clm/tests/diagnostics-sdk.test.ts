import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { hashJson } from "../src/diagnostic-fingerprint.ts";
import { createProjectionCheckpoint } from "../src/projection.ts";
import { sourceContentHash } from "../src/continuity.ts";

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const { createJiti } = require(require.resolve("jiti", { paths: [join(packageDir, "node_modules/@earendil-works/pi-coding-agent")] }));
const alias = Object.fromEntries(["@earendil-works/pi-ai/api/openai-codex-responses.lazy", "@earendil-works/pi-ai/api/openai-responses.lazy", "@earendil-works/pi-ai/compat", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"].map(name => [name, fileURLToPath(import.meta.resolve(name))]));
alias.typebox = require.resolve("typebox");
const jiti = createJiti(import.meta.url, { alias });
const clm = (await jiti.import(join(packageDir, "index.ts"))).default;
const native = await jiti.import(join(packageDir, "../pi-openai-server-compaction/openai-server-compaction.ts"));
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const apiKey = `${encoded({ alg: "none" })}.${encoded({ "https://api.openai.com/auth": { chatgpt_account_id: "SECRET_ACCOUNT" } })}.signature`;
const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-trace-offline", name: "Offline trace", baseUrl: "https://chatgpt.com/backend-api", reasoning: false, input: ["text"], contextWindow: 272000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;

for (const order of ["clm-first", "clm-last"]) for (const variant of ["ordinary", "native", "continuity", "native-continuity"]) {
  const checkpoint = variant.startsWith("native");
  const continuity = variant.includes("continuity");
  test(`Pi 1.0.4 hash-only diagnostics match fake transport in ${order}, variant=${variant}`, { timeout: 30000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "clm-diag-sdk-"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const traceDir = join(root, "traces");
    const requests: any[] = [];
    const failures: unknown[] = [];
    const notices: string[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const fetch = async (_url: unknown, init: any) => {
      const bytes = Buffer.from(init.body);
      const body = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
      requests.push(JSON.parse(body.toString()));
      const id = `SECRET_RESPONSE_${requests.length}`;
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `SECRET_MESSAGE_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "SECRET_REPLY", annotations: [], logprobs: [] }] } },
        { type: "response.completed", response: { id, status: "completed", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 128 }, output_tokens: 5, total_tokens: 1005 } } },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "x-request-id": "SECRET_REQUEST_ID" } });
    };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const modelFactory = (pi: any) => pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey, models: [model] });
    const clmFactory = (pi: any) => {
      // Exercise default-on registration and isolate files from the real agent dir.
      const previous = process.env.PI_CLM_DIAGNOSTICS;
      const previousDirectory = process.env.PI_CLM_TRACE_DIR;
      delete process.env.PI_CLM_DIAGNOSTICS;
      process.env.PI_CLM_TRACE_DIR = traceDir;
      try { clm(pi); } finally {
        if (previous === undefined) delete process.env.PI_CLM_DIAGNOSTICS; else process.env.PI_CLM_DIAGNOSTICS = previous;
        if (previousDirectory === undefined) delete process.env.PI_CLM_TRACE_DIR; else process.env.PI_CLM_TRACE_DIR = previousDirectory;
      }
    };
    const nativeFactory = (pi: any) => native.createOpenAIServerCompactionExtension({ fetchFn: fetch })({ ...pi, registerProvider(provider: string, config: any) {
      pi.registerProvider(provider, { ...config, streamSimple: (m: any, context: any, options: any) => config.streamSimple(m, context, { ...options, fetch }) });
    } });
    const factories = [modelFactory, ...(order === "clm-first" ? [clmFactory, nativeFactory] : [nativeFactory, clmFactory])];
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage({ role: "system", content: "SECRET_SYSTEM", timestamp: 0 });
    if (checkpoint) sessionManager.appendCompaction(native.SERVER_COMPACTION_SHIM_SUMMARY, null, 100, { strategy: native.SERVER_COMPACTION_STRATEGY, adapter: "codex-trigger-sse", provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl, replacementHistory: [{ type: "compaction", encrypted_content: "SECRET_CHECKPOINT" }], createdAt: "2026-10-01T00:00:00Z" }, true);
    if (continuity) {
      const initialUser = { role: "user", content: "SECRET_PREFIX_TASK", timestamp: 1 } as const;
      const sourceId = sessionManager.appendMessage(initialUser);
      sessionManager.appendCustomEntry("live-context-annotation", { version: 1, id: "lc-012345abcdef", source: { sessionId: sessionManager.getSessionId(), entryId: sourceId, revision: 0, contentHash: sourceContentHash(initialUser), role: "user" }, title: "SECRET_ANNOTATION", reason: "Keep task", futureAction: "Finish task", retention: "pin", createdAt: "2026-10-07T00:00:00Z" });
      const savedReasoning = { role: "assistant", provider: model.provider, api: model.api, model: model.id, timestamp: 2, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, content: [
        { type: "thinking", thinking: "SECRET_SUMMARY", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_offline_cache", encrypted_content: "SECRET_REASONING", summary: [] }) },
        { type: "text", text: "SECRET_VISIBLE_REPLY" },
      ] } as any;
      if (checkpoint) sessionManager.appendMessage(savedReasoning);
      else sessionManager.appendCustomEntry("live-context-state", { version: 1, enabled: true, revision: 1, checkpoint: createProjectionCheckpoint({ revision: 1, sourceMessages: [initialUser], projectedMessages: [initialUser, savedReasoning], beforeEstimate: 10, afterEstimate: 10 }) });
    }
    try {
      await resourceLoader.reload();
      ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager, modelRuntime, model: model as any }));
      await session.bindExtensions({ mode: "rpc", uiContext: { notify: (message: string) => { notices.push(message); }, setStatus() {}, setWidget() {} } as any, onError: error => failures.push(error) });
      await session.prompt("SECRET_USER_FIRST");
      await session.prompt("SECRET_USER_SECOND");
      await session.prompt("/clm-trace status");
      assert.deepEqual(failures, []);
      assert.equal(requests.length, 2);
      const folder = join(traceDir, sessionManager.getSessionId());
      const files = readdirSync(folder);
      assert.equal(files.length, 1);
      const raw = readFileSync(join(folder, files[0]), "utf8");
      const log = raw.trim().split("\n").map(line => JSON.parse(line));
      const final = log.filter(row => row.event === "request" && row.stage === "terminal");
      const pipeline = log.filter(row => row.event === "request" && row.stage === "provider-hook");
      assert.equal(final.length, 2, JSON.stringify(log));
      assert.equal(pipeline.length, 2);
      for (let i = 0; i < 2; i++) {
        assert.equal(final[i].payloadHash, hashJson(requests[i]), "terminal observation must match actual body");
        assert.equal(requests[i].model, model.id);
        assert.ok(Array.isArray(requests[i].input) && requests[i].input.length > 0, "transport must keep the Responses envelope");
        assert.equal(final[i].pipelineCorrelation, checkpoint && order === "clm-first" ? "unique-pending-route" : "unique-hash-match");
        assert.equal(final[i].requestId, pipeline[i].requestId);
        assert.equal(final[i].baseUrlHash, hashJson(model.baseUrl));
        assert.equal(final[i].compactionItems, checkpoint ? 1 : 0);
        if (continuity) {
          assert.equal(final[i].reasoningItems, 1, "keep encrypted reasoning without a manual mode");
          assert.match(JSON.stringify(requests[i]), /SECRET_VISIBLE_REPLY/);
          assert.match(JSON.stringify(requests[i]), /SECRET_REASONING/);
          assert.match(JSON.stringify(requests[i]), /SECRET_ANNOTATION/);
          const noteIndex = requests[i].input.findIndex((item: unknown) => JSON.stringify(item).includes("SECRET_ANNOTATION"));
          assert.ok(noteIndex >= 0);
          assert.equal(noteIndex, requests[0].input.findIndex((item: unknown) => JSON.stringify(item).includes("SECRET_ANNOTATION")), "continuity must not move as history grows");
        }
      }
      const usages = log.filter(row => row.event === "response_usage" && row.cachedTokens !== undefined);
      assert.equal(usages.length, 2, JSON.stringify(log));
      assert.deepEqual(usages.map(row => row.cachedTokens), [128, 128]);
      assert.deepEqual(usages.map(row => row.requestId), final.map(row => row.requestId), JSON.stringify(log.filter(row => ["request", "response_start", "response_usage"].includes(row.event))));
      assert.equal(final[1].comparison.configChanged, false);
      assert.equal(final[1].comparison.previousInputIsPrefix, true);
      if (checkpoint && order === "clm-first") assert.notEqual(final[0].payloadHash, pipeline[0].payloadHash, "native replay after our hook changes the final body");
      assert.doesNotMatch(raw, /SECRET_|signature|Bearer|chatgpt\.com/);
      assert.match(notices.at(-1)!, /Hash-only traces/);
      const normalized = log.filter(row => row.event === "assistant_usage");
      assert.deepEqual(normalized.map(row => row.cacheRead), [128, 128]);
      if (continuity && !checkpoint) {
        const saved = sessionManager.getBranch().find((entry: any) => entry.customType === "live-context-state" && entry.data?.checkpoint);
        assert.match(JSON.stringify(saved), /SECRET_REASONING/, "saved checkpoint is unchanged");
      }
      await session.prompt("/clm-trace off");
    } finally {
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
