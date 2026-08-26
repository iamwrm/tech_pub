import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureLatestAssistantSnapshot } from "../src/assistant-message.ts";
import { NvimotatorBridge } from "../src/bridge.ts";
import { ensureRegistryDirectory, prepareSocketPath } from "../src/registry.ts";
import { PROTOCOL_VERSION, type Annotation, type BridgeManifest } from "../src/protocol.ts";

function assistant(text: string, id = "assistant-1") {
  return captureLatestAssistantSnapshot([
    { id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } },
  ], "session-bridge");
}

function exchange(manifest: BridgeManifest, value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(manifest.socketPath);
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.end(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8").trim())); }
      catch (error) { reject(error); }
    });
  });
}

function request(manifest: BridgeManifest, type: string, extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `request-${type}-${Math.random().toString(16).slice(2)}`,
    type,
    token: manifest.token,
    bridgeId: manifest.bridgeId,
    instanceId: manifest.instanceId,
    sessionId: manifest.sessionId,
    snapshotId: manifest.snapshotId,
    ...extra,
  };
}

const oneAnnotation: Annotation[] = [{
  id: "annotation-1",
  kind: "comment",
  anchor: { selection: "line", startLine: 1, startByte: 0, endLine: 1, endByte: 5 },
  comment: "Please revise",
}];

test("owner-only Unix bridge authenticates, refreshes, renders, deduplicates, and finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nvimotator-bridge-"));
  const oldRegistry = process.env.PI_NVIMOTATOR_REGISTRY;
  process.env.PI_NVIMOTATOR_REGISTRY = join(root, "registry");
  const sent: string[] = [];
  const bridge = new NvimotatorBridge({
    snapshot: assistant("alpha\nomega"),
    feedbackWrapper: (feedback) => `WRAPPED\n${feedback}`,
    onSubmit: (prompt) => sent.push(prompt),
  });
  try {
    const manifest = await bridge.start();
    assert.equal(manifest.transport, "unix");
    assert.equal(manifest.socketPath, join(root, "registry", `${manifest.bridgeId}.sock`));
    const file = join(root, "registry", `${manifest.bridgeId}.json`);
    assert.equal((await stat(join(root, "registry"))).mode & 0o077, 0);
    assert.equal((await stat(file)).mode & 0o077, 0);
    const socketStat = await stat(manifest.socketPath);
    assert.equal(socketStat.isSocket(), true);
    assert.equal(socketStat.mode & 0o077, 0);
    assert.equal((JSON.parse(await readFile(file, "utf8")) as BridgeManifest).token, manifest.token);

    const wrong = await exchange(manifest, { ...request(manifest, "ping"), token: "wrong" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, "authentication_failed");

    const snapshotResponse = await exchange(manifest, request(manifest, "snapshot"));
    assert.equal(snapshotResponse.ok, true);
    assert.equal(snapshotResponse.text, "alpha\nomega");
    assert.deepEqual(snapshotResponse.quickActions.map((action: any) => action.id), [
      "deletion", "thumbs-up", "clarify-this", "missing-overview", "verify-this", "give-me-an-example",
      "match-existing-patterns", "consider-alternatives", "ensure-no-regression", "out-of-scope",
      "needs-tests", "nice-approach",
    ]);
    assert.equal(snapshotResponse.quickActions[0].label, "Deletion");
    assert.equal(snapshotResponse.quickActions[1].label, "👍 Looks good");
    assert.equal(snapshotResponse.quickActions.slice(2).length, 10);
    const invalidRender = await exchange(manifest, request(manifest, "render", {
      submissionId: "invalid-anchor",
      annotations: [{ ...oneAnnotation[0], anchor: { ...oneAnnotation[0]!.anchor!, endByte: 6 } }],
    }));
    assert.equal(invalidRender.code, "invalid_request");
    assert.equal(invalidRender.retryable, false);

    const renderRequest = request(manifest, "render", { submissionId: "submission-1", annotations: oneAnnotation });
    const rendered = await exchange(manifest, renderRequest);
    assert.equal(rendered.type, "rendered");
    assert.match(rendered.prompt, /^WRAPPED\n/);

    const submitRequest = request(manifest, "submit", { submissionId: "submission-1", annotations: oneAnnotation });
    const submitted = await exchange(manifest, submitRequest);
    const retried = await exchange(manifest, { ...submitRequest, requestId: "request-submit-retry" });
    assert.equal(submitted.status, "scheduled");
    assert.equal(retried.status, "scheduled");
    assert.deepEqual(sent, [rendered.prompt]);
    const unchanged = await bridge.updateSnapshot(assistant("alpha\nomega"));
    const afterRefresh = await exchange(unchanged, { ...submitRequest, requestId: "request-submit-after-refresh" });
    assert.equal(afterRefresh.status, "scheduled");
    assert.deepEqual(sent, [rendered.prompt]);

    const changed = assistant("replacement", "assistant-2");
    const refreshed = await bridge.updateSnapshot(changed);
    assert.equal(refreshed.bridgeId, manifest.bridgeId);
    assert.equal(refreshed.instanceId, manifest.instanceId);
    const freshSnapshot = await exchange(refreshed, request(refreshed, "snapshot"));
    assert.equal(freshSnapshot.text, "replacement");

    const freshAnnotations: Annotation[] = [{
      id: "fresh", kind: "comment",
      anchor: { selection: "line", startLine: 1, startByte: 0, endLine: 1, endByte: 11 },
      comment: "new",
    }];
    await exchange(refreshed, request(refreshed, "submit", { submissionId: "submission-2", annotations: freshAnnotations }));
    const finished = await exchange(refreshed, request(refreshed, "finish", { submissionId: "submission-2" }));
    assert.equal(finished.type, "finished");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(bridge.getState(), "stopped");
    await assert.rejects(readFile(file, "utf8"), /ENOENT/);
    await assert.rejects(stat(manifest.socketPath), /ENOENT/);
  } finally {
    await bridge.stop();
    if (oldRegistry === undefined) delete process.env.PI_NVIMOTATOR_REGISTRY;
    else process.env.PI_NVIMOTATOR_REGISTRY = oldRegistry;
    await rm(root, { recursive: true, force: true });
  }
});

test("stop racing start leaves no live bridge or manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nvimotator-start-stop-"));
  const oldRegistry = process.env.PI_NVIMOTATOR_REGISTRY;
  process.env.PI_NVIMOTATOR_REGISTRY = join(root, "registry");
  const bridge = new NvimotatorBridge({ snapshot: assistant("race"), onSubmit() {} });
  try {
    const starting = bridge.start();
    const stopping = bridge.stop();
    await Promise.allSettled([starting, stopping]);
    assert.equal(bridge.getState(), "stopped");
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(join(root, "registry")).catch(() => []));
    assert.deepEqual(files.filter((name) => name.endsWith(".json") || name.endsWith(".lock") || name.endsWith(".sock")), []);
  } finally {
    await bridge.stop().catch(() => undefined);
    if (oldRegistry === undefined) delete process.env.PI_NVIMOTATOR_REGISTRY;
    else process.env.PI_NVIMOTATOR_REGISTRY = oldRegistry;
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsafe existing registry override is rejected without chmod", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nvimotator-registry-mode-"));
  const directory = join(root, "shared");
  const oldRegistry = process.env.PI_NVIMOTATOR_REGISTRY;
  try {
    await mkdir(directory, { mode: 0o755 });
    await chmod(directory, 0o755);
    process.env.PI_NVIMOTATOR_REGISTRY = directory;
    await assert.rejects(ensureRegistryDirectory(), /owner-only/);
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  } finally {
    if (oldRegistry === undefined) delete process.env.PI_NVIMOTATOR_REGISTRY;
    else process.env.PI_NVIMOTATOR_REGISTRY = oldRegistry;
    await rm(root, { recursive: true, force: true });
  }
});
test("socket preparation refuses non-socket entries instead of unlinking them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nvimotator-socket-entry-"));
  const oldRegistry = process.env.PI_NVIMOTATOR_REGISTRY;
  try {
    process.env.PI_NVIMOTATOR_REGISTRY = join(root, "registry");
    const directory = await ensureRegistryDirectory();
    const path = join(directory, "16.sock");
    await writeFile(path, "do not remove", { mode: 0o600 });
    await assert.rejects(
      prepareSocketPath({ bridgeId: 16, directory, lockPath: join(directory, "16.lock") }),
      /not a Unix socket/,
    );
    assert.equal(await readFile(path, "utf8"), "do not remove");
    await rm(path);
    const target = join(root, "target");
    await writeFile(target, "also keep", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(
      prepareSocketPath({ bridgeId: 16, directory, lockPath: join(directory, "16.lock") }),
      /not a Unix socket/,
    );
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), "also keep");
  } finally {
    if (oldRegistry === undefined) delete process.env.PI_NVIMOTATOR_REGISTRY;
    else process.env.PI_NVIMOTATOR_REGISTRY = oldRegistry;
    await rm(root, { recursive: true, force: true });
  }
});

test("an overlong Unix socket path fails with an actionable registry override error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-nvimotator-socket-length-"));
  const oldRegistry = process.env.PI_NVIMOTATOR_REGISTRY;
  const bridge = new NvimotatorBridge({ snapshot: assistant("long path"), onSubmit() {} });
  try {
    process.env.PI_NVIMOTATOR_REGISTRY = join(root, "x".repeat(80));
    await assert.rejects(bridge.start(), /PI_NVIMOTATOR_REGISTRY to a shorter/);
    assert.equal(bridge.getState(), "stopped");
  } finally {
    await bridge.stop().catch(() => undefined);
    if (oldRegistry === undefined) delete process.env.PI_NVIMOTATOR_REGISTRY;
    else process.env.PI_NVIMOTATOR_REGISTRY = oldRegistry;
    await rm(root, { recursive: true, force: true });
  }
});
