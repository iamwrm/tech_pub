import {
  type AgentEvent,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
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
  type Btw2AgentSnapshot,
  type Btw2Dependencies,
} from "../index.ts";
import type { DetachedForkRequest, DetachedForkResult } from "../detached-session.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

const MODEL = {
  id: "gpt-5.5",
  name: "Test model",
  api: "openai-responses",
  provider: "fluxion-gpt",
  baseUrl: "https://fluxionai.space/v1",
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
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
}

function fakeContext(manager: SessionManager, capture: UiCapture): ExtensionCommandContext {
  const ui = {
    setWidget: (_key: string, lines: string[] | undefined) => capture.widgets.push(lines),
    notify: (message: string, type?: string) => capture.notifications.push({ message, type }),
    select: (title: string, options: string[]) =>
      capture.select ? capture.select(title, options) : Promise.resolve(undefined),
    input: (title: string, initialValue?: string) =>
      capture.input ? capture.input(title, initialValue) : Promise.resolve(undefined),
    editor: (title: string, prefill?: string) =>
      capture.editor ? capture.editor(title, prefill) : Promise.resolve(undefined),
    confirm: async () => false,
  };
  return {
    hasUI: true,
    mode: "tui",
    cwd: manager.getCwd(),
    model: MODEL,
    thinkingLevel: "max",
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
  manager.appendMessage(user("parent question", 10));
  manager.appendMessage(assistant("parent answer", 11));
  return manager;
}

function registerTestExtension(options: {
  fakeAgent: FakeAgent;
  materializeFork?: (request: DetachedForkRequest) => DetachedForkResult;
  captureSnapshot?: (snapshot: Btw2AgentSnapshot) => void;
}): {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  toolsHandler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  shutdown: (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
} {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let toolsHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let shutdown: ((event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
  const pi = {
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      if (name === "btw2") {
        handler = command.handler;
      } else if (name === "tools") {
        toolsHandler = command.handler;
      } else {
        assert.fail(`unexpected command ${name}`);
      }
    },
    on: (event: string, listener: typeof shutdown) => {
      if (event === "session_shutdown") shutdown = listener;
    },
    getThinkingLevel: (): ThinkingLevel => "max",
  } as unknown as ExtensionAPI;

  const deps: Partial<Btw2Dependencies> = {
    createAgent: (snapshot) => {
      options.captureSnapshot?.(snapshot);
      return options.fakeAgent as unknown as ReturnType<Btw2Dependencies["createAgent"]>;
    },
    materializeFork: options.materializeFork,
    createRunId: () => "btw2-run",
    now: (() => {
      let value = 0;
      return () => (value += 1_000);
    })(),
  };
  createBtw2Extension(deps)(pi);
  assert.ok(handler);
  assert.ok(toolsHandler);
  assert.ok(shutdown);
  return { handler, toolsHandler, shutdown };
}

async function settleBackground(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("createBtw2Agent inherits runtime settings and has no tools", () => {
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
  } as unknown as ExtensionCommandContext["modelRegistry"];
  const rewriteProviderPayload = (payload: unknown) => ({ payload, replayed: true });
  const agent = createBtw2Agent({
    model: MODEL,
    thinkingLevel: "max",
    systemPrompt: "parent system prompt",
    messages: [user("parent")],
    sessionId: "side-run",
    modelRegistry,
    rewriteProviderPayload,
  });

  assert.equal(agent.state.model, MODEL);
  assert.equal(agent.state.thinkingLevel, "max");
  assert.deepEqual(agent.state.tools, []);
  assert.deepEqual(agent.state.messages, [user("parent")]);
  assert.match(agent.state.systemPrompt, /^parent system prompt/);
  assert.match(agent.state.systemPrompt, /no tools and cannot read,\nwrite, execute, browse/);
  assert.equal(agent.sessionId, "side-run");
  assert.equal(agent.onPayload, rewriteProviderPayload);
});

test("bare /btw2 opens a question editor and Esc returns without creating state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
  try {
    const manager = fixtureManager(root);
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    const calls: Array<{ title: string; prefill?: string }> = [];
    const capture: UiCapture = {
      widgets: [],
      notifications: [],
      editor: async (title, prefill) => {
        calls.push({ title, prefill });
        return undefined;
      },
    };
    const { handler } = registerTestExtension({ fakeAgent });
    const ctx = fakeContext(manager, capture);

    await handler("", ctx);

    assert.deepEqual(calls, [{
      title: "BTW2 question · no tools · Esc returns to the main session",
      prefill: "",
    }]);
    assert.deepEqual(capture.widgets, []);
    assert.equal(fakeAgent.state.messages.length, manager.buildSessionContext().messages.length);

    await handler("--fork", ctx);
    assert.ok(capture.notifications.some(({ message }) => message === "No active BTW2 side branch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("submitting the bare /btw2 editor starts the background side branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
  try {
    const manager = fixtureManager(root);
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    const capture: UiCapture = {
      widgets: [],
      notifications: [],
      editor: async () => "  first dialog question\nwith context  ",
    };
    const { handler } = registerTestExtension({ fakeAgent });

    await handler("", fakeContext(manager, capture));
    await settleBackground();

    const submitted = fakeAgent.state.messages.at(-2);
    assert.equal(submitted?.role, "user");
    assert.deepEqual(submitted?.content, [{
      type: "text",
      text: "first dialog question\nwith context",
    }]);
    assert.ok(capture.widgets.some((lines) =>
      lines?.some((line) => line === "ready · 1 completed turn")));
    assert.ok(!capture.notifications.some(({ message }) => message.startsWith("Usage:")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/btw2 keeps the parent unchanged and materializes completed turns on demand", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
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
    assert.equal(forkRequest.sourceSessionDir, manager.getSessionDir());
    assert.equal(forkRequest.sourceSessionCwd, manager.getCwd());
    assert.equal(forkRequest.model, MODEL);
    assert.equal(forkRequest.thinkingLevel, "max");
    assert.deepEqual(
      forkRequest.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.ok(capture.notifications.some(({ message }) => message.includes("fork-session")));
    assert.deepEqual(capture.widgets.at(-1), [
      "BTW2 fork ready · fork-session",
      "Resume: pi --session fork-session",
      `Path: ${result.sessionPath}`,
      "Parent stays active; concurrent writes to the same workspace can conflict.",
      "/btw2 --dismiss to clear this notice",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/tools toggles the side branch tool set and the widget label", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
  try {
    const manager = fixtureManager(root);
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    const snapshots: Btw2AgentSnapshot[] = [];
    const { handler, toolsHandler } = registerTestExtension({
      fakeAgent,
      captureSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const capture: UiCapture = { widgets: [], notifications: [] };
    const ctx = fakeContext(manager, capture);

    await handler("first side question", ctx);
    await settleBackground();
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].tools, []);
    assert.ok(capture.widgets.at(-1)?.some((line) => line.includes("· no tools")));

    await toolsHandler("", ctx);
    assert.equal(snapshots.length, 2);
    assert.deepEqual(
      snapshots[1].tools?.map((tool) => tool.name),
      ["read", "write", "edit", "bash", "grep", "find", "ls"],
    );
    // The recreated agent keeps the frozen context plus completed turns.
    assert.equal(snapshots[1].messages.length, snapshots[0].messages.length + 2);
    assert.equal(snapshots[1].sessionId, snapshots[0].sessionId);
    assert.ok(capture.widgets.at(-1)?.some((line) => line.includes("· with tools")));
    assert.ok(capture.notifications.some(({ message }) => message.includes("read, write, edit")));

    await toolsHandler("off", ctx);
    assert.equal(snapshots.length, 3);
    assert.deepEqual(snapshots[2].tools, []);
    assert.equal(snapshots[2].messages.length, snapshots[1].messages.length);
    assert.ok(capture.widgets.at(-1)?.some((line) => line.includes("· no tools")));

    // Follow-up still works after toggling back to no-tools.
    await handler("second side question", ctx);
    await settleBackground();
    assert.ok(capture.widgets.at(-1)?.some((line) => line.startsWith("ready · 2 completed turns")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/tools without a branch and while running warn instead of mutating", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
  try {
    const manager = fixtureManager(root);
    const fakeAgent = new FakeAgent(manager.buildSessionContext().messages);
    let releasePrompt: (() => void) | undefined;
    fakeAgent.gateNextPrompt(new Promise<void>((resolve) => {
      releasePrompt = resolve;
    }));
    const snapshots: Btw2AgentSnapshot[] = [];
    const { handler, toolsHandler } = registerTestExtension({
      fakeAgent,
      captureSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    const capture: UiCapture = { widgets: [], notifications: [] };
    const ctx = fakeContext(manager, capture);

    await toolsHandler("", ctx);
    assert.equal(snapshots.length, 0);
    assert.ok(capture.notifications.some(({ message }) => message.includes("No active BTW2 side branch")));

    await handler("question", ctx);
    await toolsHandler("", ctx);
    assert.equal(snapshots.length, 1, "running branch must not be recreated");
    assert.ok(capture.notifications.some(({ message }) => message.includes("before changing tools")));

    releasePrompt?.();
    await settleBackground();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale Stop action cannot leave a completed BTW2 run stuck in stopping", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
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

test("/btw2 replays an opaque provider-native checkpoint without the shim context", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
  try {
    const manager = fixtureManager(root);
    const kept = manager.getLeafId();
    assert.ok(kept);
    const replacementHistory = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "retained parent" }] },
      { type: "compaction", encrypted_content: "opaque-checkpoint" },
    ];
    manager.appendCompaction(
      "[OpenAI native compaction checkpoint]",
      kept,
      10_000,
      {
        strategy: "openai-responses-compaction-v2",
        adapter: "standard-responses-json",
        provider: MODEL.provider,
        api: MODEL.api,
        model: MODEL.id,
        baseUrl: MODEL.baseUrl,
        replacementHistory,
        createdAt: new Date().toISOString(),
      },
      true,
    );
    const fakeAgent = new FakeAgent([]);
    let snapshot: Btw2AgentSnapshot | undefined;
    const { handler } = registerTestExtension({
      fakeAgent,
      captureSnapshot: (value) => {
        snapshot = value;
      },
    });
    const capture: UiCapture = { widgets: [], notifications: [] };

    await handler("must replay", fakeContext(manager, capture));
    await settleBackground();

    assert.ok(snapshot);
    assert.deepEqual(snapshot.messages, []);
    assert.equal(typeof snapshot.rewriteProviderPayload, "function");
    const payload = {
      model: MODEL.id,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "must replay" }] }],
    };
    assert.deepEqual(snapshot.rewriteProviderPayload?.(payload, MODEL), {
      model: MODEL.id,
      input: [...replacementHistory, ...payload.input],
    });
    assert.deepEqual(fakeAgent.state.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(capture.notifications.some(({ type }) => type === "error"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling the fork-name dialog does not materialize a session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-btw-extension-"));
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
