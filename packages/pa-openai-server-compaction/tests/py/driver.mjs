/**
 * Node stdio bridge that lets the Python/uv test harness drive the real
 * pa-openai-server-compaction TypeScript module.
 *
 * Protocol: one JSON object per line on stdin; one JSON object per line on
 * stdout. Requests carry an "id"; responses mirror it.
 *
 *   {"id": 1, "cmd": "parse_sse", "text": "..."}
 *   {"id": 1, "ok": true, "result": ...}
 *   {"id": 1, "ok": false, "error": {"name": "...", "message": "..."}}
 */
import { createInterface } from "node:readline";

const mod = await import("../../openai-server-compaction.ts");

const sleepFn = async (milliseconds) => {
  await new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 25)));
};

const commands = {
  parse_sse: ({ text }) => mod.parseCompactionSse(text),
  parse_standard: ({ text }) => mod.parseStandardCompactionResponse(text),
  retain: ({ input, maxTokens }) => mod.retainRecentUserItems(input, maxTokens),
  build_prepared: ({ payload, tail }) => mod.buildPreparedCompactionRequest(payload, tail),
  build_standard: ({ payload, tail }) => mod.buildStandardCompactionRequest(payload, tail),
  reconstruct: ({ entries, model }) => mod.reconstructReplayHistory(entries, model),
  details: ({ value }) => mod.extractServerCompactionDetails(value),
  format_usage: ({ usage }) => mod.formatCompactionUsage(usage),
  remote_compact: async (params) => {
    const {
      url,
      apiKey,
      sessionId = "sess-test",
      body,
      compactedInput,
      model,
      headers = {},
      adapter = "codex-trigger-sse",
      scenario = "ok",
    } = params;
    return mod.requestServerCompaction({
      adapter,
      url,
      model,
      apiKey,
      headers: { ...headers, "x-test-scenario": scenario, "x-test-session-id": sessionId, "x-test-api-key": apiKey },
      sessionId,
      body,
      compactedInput,
      signal: new AbortController().signal,
      fetchFn: globalThis.fetch,
      sleepFn,
    });
  },
};

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: { name: "BadRequest", message: "invalid JSON" } }) + "\n");
    return;
  }
  const handler = commands[request.cmd];
  if (!handler) {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, error: { name: "UnknownCommand", message: request.cmd } }) + "\n");
    return;
  }
  try {
    const result = await handler(request.params ?? {});
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: false,
      error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
    }) + "\n");
  }
});
