import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    protocolVersion: 2,
    bridgeId: 16,
    instanceId: "instance-1",
    sessionId: snapshot.sessionId,
    snapshotId: snapshot.snapshotId,
    entryId: snapshot.entryId,
    messageHash: snapshot.messageHash,
    pid: process.pid,
    transport: "unix",
    socketPath: "/tmp/pi-nvimotator-test/16.sock",
    token: "token",
    startedAt: new Date(0).toISOString(),
  };
}

test("activation is lazy, waits for idle, refreshes one bridge, and schedules follow-up", async () => {
  const commands: Record<string, any> = {};
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
    registerCommand(name: string, definition: any) { commands[name] = definition; },
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
  assert.ok(commands["nvim-last"]);
  assert.ok(commands["nvim-annotate"]);
  const last = commands["nvim-last"];
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
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

  await Promise.all([last.handler("", ctx), last.handler("", ctx)]);
  assert.equal(waitCount, 2);
  assert.equal(createCount, 1);
  const readyNotice = notifications.at(-1)!;
  assert.match(readyNotice, /Nvimotator ready \(16\)/);
  assert.match(readyNotice, /nvim -c 'NvimotatorAttach 16'/);
  assert.doesNotMatch(readyNotice, /PI_NVIMOTATOR_PACKAGE|runtimepath/);
  assert.equal(bridgeOptions.snapshot.kind, "message");
  bridgeOptions.onSubmit("feedback bytes");
  assert.deepEqual(sent, [{ prompt: "feedback bytes", options: { deliverAs: "followUp" } }]);

  activeBranch = branch("second", "assistant-2");
  await last.handler("", ctx);
  assert.equal(createCount, 1);
  assert.equal(waitCount, 3);

  await shutdown?.();
  assert.equal(stopCount, 1);
});

test("non-TUI mode and missing assistant fail without allocating resources", async () => {
  const commands: Record<string, any> = {};
  let created = 0;
  const notices: string[] = [];
  const pi = {
    registerCommand(name: string, definition: any) { commands[name] = definition; },
    on() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  activateNvimotator(pi, { createBridge() { created += 1; throw new Error("unexpected"); } });
  const last = commands["nvim-last"];
  const base = {
    cwd: process.cwd(),
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => [], getSessionId: () => "session" },
    ui: { notify: (message: string) => notices.push(message), setStatus: () => undefined },
  };
  await last.handler("", { ...base, mode: "json" });
  assert.match(notices.at(-1)!, /interactive TUI/);
  await last.handler("", { ...base, mode: "tui" });
  assert.match(notices.at(-1)!, /No non-empty assistant message/);
  assert.equal(created, 0);
});

test("shutdown owns commands waiting for idle and bridges still starting", async () => {
  const commands: Record<string, any> = {};
  let shutdown: (() => Promise<void>) | undefined;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
  let created = 0;
  let stopped = 0;
  const pi = {
    registerCommand(name: string, definition: any) { commands[name] = definition; },
    on(event: string, handler: any) { if (event === "session_shutdown") shutdown = handler; },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  activateNvimotator(pi, { createBridge() { created += 1; throw new Error("unexpected"); } });
  const context = {
    mode: "tui",
    cwd: process.cwd(),
    waitForIdle: () => idle,
    sessionManager: { getBranch: () => branch("waiting"), getSessionId: () => "session-wait" },
    ui: { notify() {}, setStatus() {} },
  };
  const waitingCommand = commands["nvim-last"].handler("", context);
  const waitingShutdown = shutdown!();
  resolveIdle();
  await Promise.all([waitingCommand, waitingShutdown]);
  assert.equal(created, 0);

  const commands2: Record<string, any> = {};
  let shutdown2: (() => Promise<void>) | undefined;
  let resolveStart!: (value: BridgeManifest) => void;
  const starting = new Promise<BridgeManifest>((resolve) => { resolveStart = resolve; });
  const pi2 = {
    registerCommand(name: string, definition: any) { commands2[name] = definition; },
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
  const startingCommand = commands2["nvim-last"].handler("", context2);
  while (created < 1) await new Promise((resolve) => setImmediate(resolve));
  const startingShutdown = shutdown2!();
  const fakeSnapshot = captureLatestAssistantSnapshot(branch("starting"), "session-start");
  resolveStart(manifest(fakeSnapshot));
  await Promise.all([startingCommand, startingShutdown]);
  assert.equal(stopped, 1);
});

test("nvim-annotate snapshots a local file and last-message still refreshes the same bridge", async () => {
  const commands: Record<string, any> = {};
  let createCount = 0;
  let latestSnapshot: any;
  let active = false;
  const notices: string[] = [];
  const pi = {
    registerCommand(name: string, definition: any) { commands[name] = definition; },
    on() {},
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  activateNvimotator(pi, {
    createBridge(options) {
      createCount += 1;
      latestSnapshot = options.snapshot;
      return {
        isActive: () => active,
        start: async () => { active = true; return manifest(options.snapshot); },
        updateSnapshot: async (snapshot: any) => {
          latestSnapshot = snapshot;
          return manifest(snapshot);
        },
        stop: async () => { active = false; },
      } as any;
    },
  });

  const root = await mkdtemp(join(tmpdir(), "pi-nvimotator-annotate-"));
  const filePath = join(root, "notes.md");
  await writeFile(filePath, "# Notes\nHello\n");
  const ctx = {
    mode: "tui",
    cwd: root,
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => branch("assistant text"), getSessionId: () => "session-1" },
    ui: { notify: (message: string) => notices.push(message), setStatus: () => undefined, select: async () => undefined },
  };

  await commands["nvim-annotate"].handler("", ctx);
  assert.match(notices.at(-1)!, /Usage: \/nvim-annotate <path>/);
  assert.equal(createCount, 0);

  await writeFile(join(root, ".env"), "SECRET=1\n");
  await commands["nvim-annotate"].handler(join(root, ".env"), ctx);
  assert.match(notices.at(-1)!, /secrets/);
  assert.equal(createCount, 0);

  await commands["nvim-annotate"].handler(filePath, ctx);
  assert.equal(createCount, 1);
  assert.equal(latestSnapshot.kind, "file");
  assert.equal(latestSnapshot.filePath, filePath);
  assert.match(notices.at(-1)!, /Nvimotator ready \(16\)/);
  assert.match(notices.at(-1)!, /File: /);
  assert.match(notices.at(-1)!, /nvim -c 'NvimotatorAttach 16'/);

  await commands["nvim-last"].handler("", ctx);
  assert.equal(createCount, 1);
  assert.equal(latestSnapshot.kind, "message");
  assert.match(latestSnapshot.text, /assistant text/);
});
