import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateNvimotator } from "../index.ts";
import { captureLatestAssistantSnapshot } from "../src/assistant-message.ts";
import type { BridgeManifest } from "../src/protocol.ts";

function branch(text: string, id = "assistant-1") {
  return [{ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }];
}

function manifest(snapshot: any): BridgeManifest {
  return {
    protocolVersion: 1,
    bridgeId: 16,
    instanceId: "instance-1",
    sessionId: snapshot.sessionId,
    snapshotId: snapshot.snapshotId,
    entryId: snapshot.entryId,
    messageHash: snapshot.messageHash,
    pid: process.pid,
    host: "127.0.0.1",
    port: 12345,
    token: "token",
    startedAt: new Date(0).toISOString(),
  };
}

test("activation is lazy, waits for idle, refreshes one bridge, and schedules follow-up", async () => {
  let command: any;
  let shutdown: (() => Promise<void>) | undefined;
  let createCount = 0;
  let waitCount = 0;
  let stopCount = 0;
  const sent: Array<{ prompt: string; options: unknown }> = [];
  const notifications: string[] = [];
  let activeBranch = branch("first");
  let bridgeOptions: any;
  let active = false;

  const pi = {
    registerCommand(_name: string, definition: any) { command = definition; },
    on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    sendUserMessage(prompt: string, options: unknown) { sent.push({ prompt, options }); },
  } as unknown as ExtensionAPI;

  activateNvimotator(pi, {
    createBridge(options) {
      createCount += 1;
      bridgeOptions = options;
      return {
        isActive: () => active,
        start: async () => { active = true; return manifest(options.snapshot); },
        updateSnapshot: async (snapshot: any) => manifest(snapshot),
        stop: async () => { active = false; stopCount += 1; },
      } as any;
    },
  });

  assert.equal(createCount, 0);
  assert.ok(command);
  const ctx = {
    mode: "tui",
    waitForIdle: async () => { waitCount += 1; },
    sessionManager: {
      getBranch: () => activeBranch,
      getSessionId: () => "session-1",
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => undefined,
    },
  };

  await Promise.all([command.handler("", ctx), command.handler("", ctx)]);
  assert.equal(waitCount, 2);
  assert.equal(createCount, 1);
  const readyNotice = notifications.at(-1)!;
  assert.match(readyNotice, /Nvimotator ready \(16\)/);
  assert.match(readyNotice, /nvim -c 'NvimotatorAttach 16'/);
  assert.doesNotMatch(readyNotice, /PI_NVIMOTATOR_PACKAGE|runtimepath/);
  bridgeOptions.onSubmit("feedback bytes");
  assert.deepEqual(sent, [{ prompt: "feedback bytes", options: { deliverAs: "followUp" } }]);

  activeBranch = branch("second", "assistant-2");
  await command.handler("", ctx);
  assert.equal(createCount, 1);
  assert.equal(waitCount, 3);

  await shutdown?.();
  assert.equal(stopCount, 1);
});

test("non-TUI mode and missing assistant fail without allocating resources", async () => {
  let command: any;
  let created = 0;
  const notices: string[] = [];
  const pi = {
    registerCommand(_name: string, definition: any) { command = definition; },
    on() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  activateNvimotator(pi, { createBridge() { created += 1; throw new Error("unexpected"); } });
  const base = {
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => [], getSessionId: () => "session" },
    ui: { notify: (message: string) => notices.push(message), setStatus: () => undefined },
  };
  await command.handler("", { ...base, mode: "json" });
  assert.match(notices.at(-1)!, /interactive TUI/);
  await command.handler("", { ...base, mode: "tui" });
  assert.match(notices.at(-1)!, /No non-empty assistant message/);
  assert.equal(created, 0);
});

test("shutdown owns commands waiting for idle and bridges still starting", async () => {
  let command: any;
  let shutdown: (() => Promise<void>) | undefined;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
  let created = 0;
  let stopped = 0;
  const pi = {
    registerCommand(_name: string, definition: any) { command = definition; },
    on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  activateNvimotator(pi, { createBridge() { created += 1; throw new Error("unexpected"); } });
  const context = {
    mode: "tui",
    waitForIdle: () => idle,
    sessionManager: { getBranch: () => branch("waiting"), getSessionId: () => "session-wait" },
    ui: { notify() {}, setStatus() {} },
  };
  const waitingCommand = command.handler("", context);
  const waitingShutdown = shutdown!();
  resolveIdle();
  await Promise.all([waitingCommand, waitingShutdown]);
  assert.equal(created, 0);

  let command2: any;
  let shutdown2: (() => Promise<void>) | undefined;
  let resolveStart!: (value: BridgeManifest) => void;
  const starting = new Promise<BridgeManifest>((resolve) => { resolveStart = resolve; });
  const pi2 = {
    registerCommand(_name: string, definition: any) { command2 = definition; },
    on(event: string, handler: any) { if (event === "session_shutdown") shutdown2 = handler; },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  activateNvimotator(pi2, {
    createBridge(options) {
      created += 1;
      return {
        isActive: () => false,
        start: () => starting,
        updateSnapshot: async () => manifest(options.snapshot),
        stop: async () => { stopped += 1; },
      } as any;
    },
  });
  const context2 = {
    ...context,
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => branch("starting"), getSessionId: () => "session-start" },
  };
  const startingCommand = command2.handler("", context2);
  while (created < 1) await new Promise((resolve) => setImmediate(resolve));
  const startingShutdown = shutdown2!();
  const fakeSnapshot = captureLatestAssistantSnapshot(branch("starting"), "session-start");
  resolveStart(manifest(fakeSnapshot));
  await Promise.all([startingCommand, startingShutdown]);
  assert.equal(stopped, 1);
});
