import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDiagnostics } from "../src/diagnostics.ts";

test("slim outcome entries keep active checkpoint counts and observation errors never escape", () => {
  const dir = mkdtempSync(join(tmpdir(), "clm-diag-state-"));
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, fn: Function) => { handlers.set(name, fn); },
    registerCommand() {},
    events: { on: () => () => {} },
  } as unknown as ExtensionAPI;
  const checkpoint = { version: 1, revision: 2, sourceMessageCount: 304, sourceDigest: "a".repeat(64), projectedMessages: [{ role: "user", content: "SECRET_PROMPT" }], beforeEstimate: 2000, afterEstimate: 1000, createdAt: "2026-10-07T00:00:00Z" };
  const entries = [
    { type: "custom", customType: "live-context-state", data: { version: 1, enabled: true, revision: 2, checkpoint } },
    { type: "custom", customType: "live-context-state", data: { version: 1, enabled: false, revision: 2 } },
  ];
  const ctx = { model: { provider: "offline", api: "openai-responses", id: "offline" }, sessionManager: { getSessionId: () => "state", getBranch: () => entries } };
  try {
    installDiagnostics(pi, { enabled: true, directory: dir });
    handlers.get("session_start")!({}, ctx);
    const input = { model: "offline", input: [{ type: "function_call_output", output: "SECRET_TOOL_OUTPUT" }] };
    assert.equal(handlers.get("before_provider_request")!({ payload: input }, ctx), undefined);
    assert.doesNotThrow(() => handlers.get("before_provider_headers")!({ headers: null }, ctx));
    const badCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => { throw new Error("SECRET_ERROR"); } } };
    assert.doesNotThrow(() => handlers.get("before_provider_request")!({ payload: input }, badCtx));
    assert.doesNotThrow(() => handlers.get("session_tree")!({}, badCtx));
    handlers.get("session_shutdown")!({}, ctx);
    const raw = readFileSync(join(dir, "state", readdirSync(join(dir, "state"))[0]), "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.find(row => row.event === "request").clm, { revision: 2, enabled: false, sourceMessageCount: 304, projectedMessageCount: 1 });
    assert.equal(rows.filter(row => row.event === "diagnostic_error").length, 3);
    assert.doesNotMatch(raw, /SECRET_/);
    assert.equal(entries.length, 2, "observations never persist new session entries");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
