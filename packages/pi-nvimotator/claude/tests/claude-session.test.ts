import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureLatestClaudeMessage,
  findClaudeSessionById,
  getRecentClaudeMessages,
  projectSlugFromCwd,
  resolveClaudeSession,
  resolveClaudeSessionByAncestorPids,
  resolveClaudeSessionByCwdScan,
} from "../src/claude-session.ts";
import { snapshotClaudeLastMessage } from "../src/snapshot.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const liveLog = join(fixtures, "transcript-live.jsonl");
const staleLog = join(fixtures, "transcript-stale.jsonl");
const activeLog = join(fixtures, "transcript-active.jsonl");

async function layout(cwd = "/work/demo") {
  const root = await mkdtemp(join(tmpdir(), "claude-nvimotator-log-"));
  const projectsDir = join(root, "projects");
  const sessionsDir = join(root, "sessions");
  const slug = projectSlugFromCwd(cwd);
  await mkdir(join(projectsDir, slug), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  return { root, projectsDir, sessionsDir, slug, cwd };
}

test("fixture transcript prefers the active-branch last message and concatenates chunks", () => {
  const [latest] = getRecentClaudeMessages(liveLog, 1, { activeBranchOnly: true });
  assert.equal(latest?.messageId, "msg_new");
  assert.equal(latest?.text, "Latest rendered\nsecond line\nchunk two");
  assert.doesNotMatch(latest?.text ?? "", /Orphaned|Should not be visible|hidden chain/);
  const unfiltered = getRecentClaudeMessages(liveLog, 3);
  assert.equal(unfiltered[0]?.messageId, "msg_orphan");
});

test("snapshotClaudeLastMessage reuses Pi snapshot limits and hashes", () => {
  const snapshot = snapshotClaudeLastMessage({ logPath: liveLog });
  assert.equal(snapshot.kind, "message");
  assert.equal(snapshot.text, "Latest rendered\nsecond line\nchunk two");
  assert.equal(snapshot.entryId, "msg_new");
  assert.equal(snapshot.sessionId, "sess-live");
  assert.equal(snapshot.snapshotId.length, 64);
  assert.ok(Object.isFrozen(snapshot));
});

test("beforeActiveTurn skips an in-progress nvimotator skill stub", () => {
  const during = captureLatestClaudeMessage({ logPath: activeLog, beforeActiveTurn: false });
  assert.equal(during.messageId, "msg_stub");
  const previous = captureLatestClaudeMessage({ logPath: activeLog });
  assert.equal(previous.messageId, "msg_final");
  assert.equal(previous.text, "Substantive final answer");
});

test("session-id env/path lookup beats cwd mtime when both exist", async () => {
  const { projectsDir, sessionsDir, slug, cwd } = await layout();
  await writeFile(join(projectsDir, slug, "sess-live.jsonl"), await (await import("node:fs/promises")).readFile(liveLog));
  await writeFile(join(projectsDir, slug, "sess-stale.jsonl"), await (await import("node:fs/promises")).readFile(staleLog));
  // Make stale newer so mtime would pick the wrong file.
  const later = Date.now() + 10_000;
  const { utimes } = await import("node:fs/promises");
  await utimes(join(projectsDir, slug, "sess-stale.jsonl"), later / 1000, later / 1000);
  assert.equal(
    findClaudeSessionById("sess-live", projectsDir, cwd),
    join(projectsDir, slug, "sess-live.jsonl"),
  );
  const resolved = resolveClaudeSession({
    cwd,
    projectsDir,
    sessionsDir,
    sessionId: "sess-live",
    startPid: 1,
  });
  assert.equal(resolved, join(projectsDir, slug, "sess-live.jsonl"));
  const latest = captureLatestClaudeMessage({ logPath: resolved! });
  assert.equal(latest.messageId, "msg_new");
});

test("ancestor PID metadata walks past a bash parent to the Claude session file", async () => {
  const cwd = "/work/demo";
  const { projectsDir, sessionsDir, slug } = await layout(cwd);
  await writeFile(join(projectsDir, slug, "sess-live.jsonl"), await (await import("node:fs/promises")).readFile(liveLog));
  await writeFile(join(sessionsDir, "111.json"), JSON.stringify({
    pid: 111,
    sessionId: "sess-live",
    cwd,
    startedAt: 100,
  }));
  const parents = new Map<number, number>([[50, 99], [99, 111], [111, 1]]);
  const path = resolveClaudeSessionByAncestorPids({
    startPid: 50,
    sessionsDir,
    projectsDir,
    getParentPid: (pid) => parents.get(pid) ?? null,
  });
  assert.equal(path, join(projectsDir, slug, "sess-live.jsonl"));
});

test("cwd-scan metadata prefers the newest startedAt for the same cwd", async () => {
  const cwd = "/work/demo";
  const { projectsDir, sessionsDir, slug } = await layout(cwd);
  await writeFile(join(projectsDir, slug, "sess-live.jsonl"), await (await import("node:fs/promises")).readFile(liveLog));
  await writeFile(join(projectsDir, slug, "sess-stale.jsonl"), await (await import("node:fs/promises")).readFile(staleLog));
  await writeFile(join(sessionsDir, "1.json"), JSON.stringify({
    pid: 1, sessionId: "sess-stale", cwd, startedAt: 10,
  }));
  await writeFile(join(sessionsDir, "2.json"), JSON.stringify({
    pid: 2, sessionId: "sess-live", cwd, startedAt: 20,
  }));
  const path = resolveClaudeSessionByCwdScan({ cwd, sessionsDir, projectsDir });
  assert.equal(path, join(projectsDir, slug, "sess-live.jsonl"));
});

test("ghost /clear jsonl wins over stale ancestor-PID metadata", async () => {
  const cwd = "/work/demo";
  const { projectsDir, sessionsDir, slug } = await layout(cwd);
  const live = join(projectsDir, slug, "sess-live.jsonl");
  const stale = join(projectsDir, slug, "sess-stale.jsonl");
  await writeFile(live, await (await import("node:fs/promises")).readFile(liveLog));
  await writeFile(stale, await (await import("node:fs/promises")).readFile(staleLog));
  const later = Date.now() + 50_000;
  const { utimes } = await import("node:fs/promises");
  await utimes(live, later / 1000, later / 1000);
  await writeFile(join(sessionsDir, "111.json"), JSON.stringify({
    pid: 111, sessionId: "sess-stale", cwd, startedAt: 1,
  }));
  const path = resolveClaudeSessionByAncestorPids({
    startPid: 111,
    sessionsDir,
    projectsDir,
    getParentPid: (pid) => (pid === 111 ? 1 : null),
  });
  assert.equal(path, live);
});
