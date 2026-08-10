import {
  type AgentEvent,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBtw2Agent,
  createBtw2Extension,
  type Btw2Dependencies,
} from "../index.ts";
import type { DetachedForkRequest, DetachedForkResult } from "../detached-session.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

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

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

class FakeAgent {
  readonly state: { messages: AgentMessage[] };
  private listeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
  private answerNumber = 0;
  private nextGate: Promise<void> | undefined;
  abortCount = 0;

  constructor(messages: readonly AgentMessage[]) {
    this.state = { messages: structuredClone([...messages]) };
  }

  gateNextPrompt(gate: Promise<void>): void {
    this.nextGate = gate;
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    };
  }

  async prompt(text: string): Promise<void> {
    const gate = this.nextGate;
    this.nextGate = undefined;
    if (gate) await gate;
    const nextUser = user(text, 100 + this.answerNumber * 2);
    const nextAssistant = assistant(`answer ${++this.answerNumber}: ${text}`, 101 + this.answerNumber * 2);
    this.state.messages.push(nextUser, nextAssistant);
    for (const listener of this.listeners) {
      await listener({ type: "message_end", message: nextAssistant });
    }
  }

  abort(): void {
    this.abortCount++;
  }
}

interface UiCapture {
  widgets: Array<string[] | undefined>;
  notifications: Array<{ message: string; type?: string }>;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, initialValue?: string) => Promise<string | undefined>;
}

function fakeContext(manager: SessionManager, capture: UiCapture): ExtensionCommandContext {
  const ui = {
    setWidget: (_key: string, lines: string[] | undefined) => capture.widgets.push(lines),
    notify: (message: string, type?: string) => capture.notifications.push({ message, type }),
    select: (title: string, options: string[]) =>
      capture.select ? capture.select(title, options) : Promise.resolve(undefined),
    input: (title: string, initialValue?: string) =>
      capture.input ? capture.input(title, initialValue) : Promise.resolve(undefined),
    editor: async () => undefined,
    confirm: async () => false,
  };
  return {
    hasUI: true,
    model: MODEL,
    sessionManager: manager,
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    getSystemPrompt: () => "captured parent system prompt",
    ui,
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
}

function fixtureManager(root: string): SessionManager {
  const manager = SessionManager.create(join(root, "workspace"), join(root, "sessions"));
  manager.appendModelChange(MODEL.provider, MODEL.id);
  manager.appendThinkingLevelChange("max");
  manager.appendServiceTierChange("priority");
  manager.appendMessage(user("parent question", 10));
  manager.appendMessage(assistant("parent answer", 11));
  manager.appendSessionState({ status: "active" });
  manager.flushNow();
  return manager;
}

function registerTestExtension(options: {
  fakeAgent: FakeAgent;
  materializeFork?: (request: DetachedForkRequest) => DetachedForkResult;
}): {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  shutdown: (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
} {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let shutdown: ((event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
  const pi = {
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      assert.equal(name, "btw2");
      handler = command.handler;
    },
    on: (event: string, listener: typeof shutdown) => {
      if (event === "session_shutdown") shutdown = listener;
    },
    getThinkingLevel: (): ThinkingLevel => "max",
  } as unknown as ExtensionAPI;

  const deps: Partial<Btw2Dependencies> = {
    createAgent: () => options.fakeAgent as unknown as ReturnType<Btw2Dependencies["createAgent"]>,
    materializeFork: options.materializeFork,
    createRunId: () => "btw2-run",
    now: (() => {
      let value = 0;
      return () => (value += 1_000);
    })(),
  };
  createBtw2Extension(deps)(pi);
  assert.ok(handler);
  assert.ok(shutdown);
  return { handler, shutdown };
}

async function settleBackground(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("createBtw2Agent inherits runtime settings and has no tools", () => {
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
  } as unknown as ExtensionCommandContext["modelRegistry"];
  const agent = createBtw2Agent({
    model: MODEL,
    thinkingLevel: "max",
    serviceTier: "priority" as ServiceTier,
    systemPrompt: "parent system prompt",
    messages: [user("parent")],
    sessionId: "side-run",
    modelRegistry,
  });

  assert.equal(agent.state.model, MODEL);
  assert.equal(agent.state.thinkingLevel, "max");
  assert.equal(agent.state.serviceTier, "priority");
  assert.deepEqual(agent.state.tools, []);
  assert.deepEqual(agent.state.messages, [user("parent")]);
  assert.match(agent.state.systemPrompt, /^parent system prompt/);
  assert.match(agent.state.systemPrompt, /no tools and cannot read,\nwrite, execute, browse/);
  assert.equal(agent.sessionId, "side-run");
});

test("/btw2 keeps the parent unchanged and materializes completed turns on demand", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-extension-"));
  try {
    const manager = fixtureManager(root);
    const parentPath = manager.getSessionFile();
    assert.ok(parentPath);
    const parentBytes = readFileSync(parentPath, "utf8");
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    let forkRequest: DetachedForkRequest | undefined;
    const result: DetachedForkResult = {
      sessionId: "fork-session",
      sessionPath: join(root, "sessions", "fork-session.jsonl"),
      parentSessionPath: parentPath,
      cwd: manager.getCwd(),
    };
    const { handler } = registerTestExtension({
      fakeAgent,
      materializeFork: (request) => {
        forkRequest = request;
        return result;
      },
    });
    const capture: UiCapture = { widgets: [], notifications: [] };
    const ctx = fakeContext(manager, capture);

    await handler("first side question", ctx);
    await settleBackground();
    await handler("second side question", ctx);
    await settleBackground();

    assert.equal(readFileSync(parentPath, "utf8"), parentBytes);
    assert.ok(capture.widgets.some((lines) => lines?.some((line) => line.includes("2 completed turns"))));

    await handler("--fork Detached name", ctx);
    assert.ok(forkRequest);
    assert.equal(forkRequest.name, "Detached name");
    assert.equal(forkRequest.sourceSessionId, manager.getSessionId());
    assert.equal(forkRequest.sourceLeafId, manager.getLeafId());
    assert.equal(forkRequest.model, MODEL);
    assert.equal(forkRequest.thinkingLevel, "max");
    assert.equal(forkRequest.serviceTier, "priority");
    assert.deepEqual(
      forkRequest.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.ok(capture.notifications.some(({ message }) => message.includes("fork-session")));
    assert.deepEqual(capture.widgets.at(-1), [
      "BTW2 fork ready · fork-session",
      "Resume: prime-agent -r fork-session",
      `Path: ${result.sessionPath}`,
      "Parent stays active; concurrent writes to the same workspace can conflict.",
      "/btw2 --dismiss to clear this notice",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale Stop action cannot leave a completed BTW2 run stuck in stopping", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-extension-"));
  try {
    const manager = fixtureManager(root);
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    let releasePrompt: (() => void) | undefined;
    fakeAgent.gateNextPrompt(new Promise<void>((resolve) => {
      releasePrompt = resolve;
    }));
    let resolveSelect: ((value: string) => void) | undefined;
    const capture: UiCapture = {
      widgets: [],
      notifications: [],
      select: () => new Promise<string | undefined>((resolve) => {
        resolveSelect = (value) => resolve(value);
      }),
    };
    const { handler } = registerTestExtension({ fakeAgent });
    const ctx = fakeContext(manager, capture);

    await handler("question", ctx);
    const browse = handler("", ctx);
    await settleBackground();
    releasePrompt?.();
    await settleBackground();
    resolveSelect?.("Stop current response");
    await browse;

    assert.ok(capture.notifications.some(({ message }) => message === "BTW2 response already finished"));
    assert.ok(capture.widgets.at(-1)?.some((line) => line.startsWith("ready · 1 completed turn")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("/btw2 refuses an opaque provider-native checkpoint on the active branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-extension-"));
  try {
    const manager = fixtureManager(root);
    const kept = manager.getLeafId();
    assert.ok(kept);
    manager.appendCompaction(
      "[OpenAI native compaction checkpoint]",
      kept,
      10_000,
      { strategy: "openai-responses-compaction-v2" },
      true,
    );
    manager.flushNow();
    const fakeAgent = new FakeAgent([]);
    const { handler } = registerTestExtension({ fakeAgent });
    const capture: UiCapture = { widgets: [], notifications: [] };

    await handler("must not run", fakeContext(manager, capture));
    await settleBackground();

    assert.ok(capture.notifications.some(({ message, type }) =>
      type === "error" && message.includes("opaque OpenAI server-compaction checkpoint")));
    assert.deepEqual(fakeAgent.state.messages, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling the fork-name dialog does not materialize a session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pa-btw2-extension-"));
  try {
    const manager = fixtureManager(root);
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    let materializeCount = 0;
    const { handler } = registerTestExtension({
      fakeAgent,
      materializeFork: () => {
        materializeCount++;
        throw new Error("must not materialize");
      },
    });
    const capture: UiCapture = {
      widgets: [],
      notifications: [],
      select: async () => "Fork to detached session",
      input: async () => undefined,
    };
    const ctx = fakeContext(manager, capture);
    await handler("question", ctx);
    await settleBackground();
    await handler("", ctx);
    assert.equal(materializeCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
