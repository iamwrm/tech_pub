import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { materializeDetachedFork } from "../detached-session.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
} as Model<any>;

function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp,
  };
}

function createSource(root: string): {
  cwd: string;
  sessionsDir: string;
  manager: SessionManager;
  sourcePath: string;
  sourceBytes: string;
  anchorLeafId: string;
} {
  const cwd = join(root, "workspace");
  const sessionsDir = join(root, "sessions");
  const manager = SessionManager.create(cwd, sessionsDir);
  manager.appendModelChange(MODEL.provider, MODEL.id);
  manager.appendThinkingLevelChange("high");
  manager.appendServiceTierChange("priority");
  manager.appendMessage(user("parent question", 10));
  const anchorLeafId = manager.appendMessage(assistant("parent answer", 11));
  manager.appendSessionState({ status: "active" });
  manager.flushNow();
  const sourcePath = manager.getSessionFile();
  assert.ok(sourcePath);
  return {
    cwd,
    sessionsDir,
    manager,
    sourcePath,
    sourceBytes: readFileSync(sourcePath, "utf8"),
    anchorLeafId,
  };
}

test("materializeDetachedFork atomically publishes a resumable sleeping branch", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-test-"));
  try {
    const source = createSource(root);
    const sideMessages: AgentMessage[] = [
      user("side question", 20),
      assistant("side answer", 21),
      user("side follow-up", 22),
      assistant("side follow-up answer", 23),
    ];

    const result = materializeDetachedFork({
      sourceSessionFile: source.sourcePath,
      sourceSessionDir: source.sessionsDir,
      sourceSessionId: source.manager.getSessionId(),
      sourceSessionCwd: source.cwd,
      sourceLeafId: source.anchorLeafId,
      model: MODEL,
      thinkingLevel: "max",
      serviceTier: "priority",
      messages: sideMessages,
      name: "Detached BTW2",
    });

    assert.notEqual(result.sessionId, source.manager.getSessionId());
    assert.equal(result.parentSessionPath, source.sourcePath);
    assert.equal(result.cwd, source.cwd);
    assert.equal(result.sessionPath, join(source.sessionsDir, `${result.sessionId}.jsonl`));
    assert.equal(readFileSync(source.sourcePath, "utf8"), source.sourceBytes, "source file must remain byte-identical");
    assert.equal(
      readdirSync(source.sessionsDir).filter((name) => name.startsWith(".pa-btw2-")).length,
      0,
      "staging directories must be removed",
    );

    const target = SessionManager.open(result.sessionPath);
    assert.equal(target.getSessionId(), result.sessionId);
    assert.equal(target.getHeader()?.parentSession, source.sourcePath);
    assert.equal(target.getCwd(), source.cwd);
    assert.equal(target.getSessionName(), "Detached BTW2");

    const entries = target.getEntries();
    const latestState = entries.findLast((entry) => entry.type === "session_state");
    assert.deepEqual(latestState?.type === "session_state" ? latestState.state : undefined, {
      status: "archived",
    });

    const context = target.buildSessionContext();
    assert.deepEqual(
      context.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) =>
          message.role === "user"
            ? typeof message.content === "string"
              ? message.content
              : message.content.map((part) => part.type === "text" ? part.text : "").join("")
            : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        ),
      ["parent question", "parent answer", "side question", "side answer", "side follow-up", "side follow-up answer"],
    );
    assert.deepEqual(context.model, { provider: MODEL.provider, modelId: MODEL.id });
    assert.equal(context.thinkingLevel, "max");
    assert.equal(context.serviceTier, "priority");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeDetachedFork rejects stale source identity and removes staging", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-test-"));
  try {
    const source = createSource(root);
    assert.throws(
      () => materializeDetachedFork({
        sourceSessionFile: source.sourcePath,
        sourceSessionDir: source.sessionsDir,
        sourceSessionId: "wrong-session",
        sourceSessionCwd: source.cwd,
        sourceLeafId: source.anchorLeafId,
        model: MODEL,
        thinkingLevel: "high",
        serviceTier: "priority",
        messages: [user("side"), assistant("answer")],
      }),
      /parent session changed/,
    );
    assert.equal(
      readdirSync(source.sessionsDir).filter((name) => name.startsWith(".pa-btw2-")).length,
      0,
    );
    assert.equal(readFileSync(source.sourcePath, "utf8"), source.sourceBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeDetachedFork rejects a missing anchor without publishing a target", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-test-"));
  try {
    const source = createSource(root);
    const before = new Set(readdirSync(source.sessionsDir));
    assert.throws(
      () => materializeDetachedFork({
        sourceSessionFile: source.sourcePath,
        sourceSessionDir: source.sessionsDir,
        sourceSessionId: source.manager.getSessionId(),
        sourceSessionCwd: source.cwd,
        sourceLeafId: "missing-entry",
        model: MODEL,
        thinkingLevel: "high",
        serviceTier: "priority",
        messages: [user("side"), assistant("answer")],
      }),
      /fork anchor is not present/,
    );
    assert.deepEqual(new Set(readdirSync(source.sessionsDir)), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("materializeDetachedFork rejects legacy parents without migrating them", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-test-"));
  try {
    const source = createSource(root);
    const lines = source.sourceBytes.trimEnd().split("\n");
    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    header.version = 2;
    lines[0] = JSON.stringify(header);
    const legacyBytes = `${lines.join("\n")}\n`;
    writeFileSync(source.sourcePath, legacyBytes);

    assert.throws(
      () => materializeDetachedFork({
        sourceSessionFile: source.sourcePath,
        sourceSessionDir: source.sessionsDir,
        sourceSessionId: source.manager.getSessionId(),
        sourceSessionCwd: source.cwd,
        sourceLeafId: source.anchorLeafId,
        model: MODEL,
        thinkingLevel: "high",
        serviceTier: "priority",
        messages: [user("side"), assistant("answer")],
      }),
      /requires current session format v3/,
    );
    assert.equal(readFileSync(source.sourcePath, "utf8"), legacyBytes);
    assert.equal(
      readdirSync(source.sessionsDir).filter((name) => name.startsWith(".pa-btw2-")).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeDetachedFork rejects malformed parents without repairing them", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-test-"));
  try {
    const source = createSource(root);
    const malformedBytes = `${source.sourceBytes}{not-json\n`;
    writeFileSync(source.sourcePath, malformedBytes);

    assert.throws(
      () => materializeDetachedFork({
        sourceSessionFile: source.sourcePath,
        sourceSessionDir: source.sessionsDir,
        sourceSessionId: source.manager.getSessionId(),
        sourceSessionCwd: source.cwd,
        sourceLeafId: source.anchorLeafId,
        model: MODEL,
        thinkingLevel: "high",
        serviceTier: "priority",
        messages: [user("side"), assistant("answer")],
      }),
      /contains malformed JSONL/,
    );
    assert.equal(readFileSync(source.sourcePath, "utf8"), malformedBytes);
    assert.equal(
      readdirSync(source.sessionsDir).filter((name) => name.startsWith(".pa-btw2-")).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
