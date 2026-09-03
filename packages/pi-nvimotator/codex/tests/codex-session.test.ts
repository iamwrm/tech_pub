import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  captureLatestCodexMessage,
  findCodexRolloutByCwd,
  findCodexRolloutByThreadId,
  getLastCodexMessage,
  getRecentCodexMessages,
  resolveCodexRollout,
} from "../src/codex-session.ts";
import { snapshotCodexLastMessage } from "../src/snapshot.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const liveLog = join(fixtures, "rollout-live.jsonl");
const staleLog = join(fixtures, "rollout-stale.jsonl");
const activeLog = join(fixtures, "rollout-active.jsonl");

const LIVE_THREAD = "0196f8a2-aaaa-bbbb-cccc-1234567890ab";
const STALE_THREAD = "0196f8a2-dddd-eeee-ffff-1234567890ab";

async function layout() {
  const home = await mkdtemp(join(tmpdir(), "codex-nvimotator-home-"));
  const dayDir = join(home, "sessions", "2026", "06", "04");
  await mkdir(dayDir, { recursive: true });
  const live = join(dayDir, `rollout-2026-06-04T10-00-00-${LIVE_THREAD}.jsonl`);
  const stale = join(dayDir, `rollout-2026-06-04T09-00-00-${STALE_THREAD}.jsonl`);
  await copyFile(liveLog, live);
  await copyFile(staleLog, stale);
  const later = Date.now() / 1000 + 10;
  await utimes(live, later, later);
  return { home, sessionsDir: join(home, "sessions"), live, stale, dayDir };
}

test("fixture rollout prefers the last assistant output_text and concatenates blocks", () => {
  const latest = getLastCodexMessage(liveLog);
  assert.equal(latest?.text, "Latest rendered\nsecond line");
  assert.match(latest?.messageId ?? "", /^codex-msg-\d+$/);
  const recent = getRecentCodexMessages(liveLog, 3);
  assert.equal(recent[0]?.text, "Latest rendered\nsecond line");
  assert.equal(recent[1]?.text, "Let me look into that.");
  assert.equal(recent[2]?.text, "Older answer");
  assert.equal(recent.every((message) => !/Should not be visible|System instructions|Fix the bug/.test(message.text)), true);
});

test("parser skips function_call, user, developer, and empty assistant text", () => {
  const latest = getLastCodexMessage(liveLog);
  assert.doesNotMatch(latest?.text ?? "", /file1\.ts|exec_command|Hello|System/);
});

test("beforeActiveTurn skips the in-progress turn's assistant stub", () => {
  const during = getLastCodexMessage(activeLog);
  assert.equal(during?.text, "I'll open nvimotator on my last response.");
  const previous = getLastCodexMessage(activeLog, { beforeActiveTurn: true });
  assert.equal(previous?.text, "Substantive final answer");
});

test("snapshotCodexLastMessage reuses Pi snapshot limits and hashes", () => {
  const snapshot = snapshotCodexLastMessage({ logPath: liveLog });
  assert.equal(snapshot.kind, "message");
  assert.equal(snapshot.text, "Latest rendered\nsecond line");
  assert.equal(snapshot.sessionId, "rollout-live");
  assert.match(snapshot.entryId, /^codex-msg-\d+$/);
  assert.equal(snapshot.snapshotId.length, 64);
  assert.ok(Object.isFrozen(snapshot));
});

test("captureLatestCodexMessage skips an active-turn stub then falls back", () => {
  const captured = captureLatestCodexMessage({ logPath: activeLog });
  assert.equal(captured.text, "Substantive final answer");
});

test("CODEX_THREAD_ID lookup beats cwd and newest mtime", async () => {
  const { home, sessionsDir, live } = await layout();
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(findCodexRolloutByThreadId(LIVE_THREAD, sessionsDir), live);
    assert.equal(findCodexRolloutByThreadId("no-such-thread", sessionsDir), null);
    const resolved = resolveCodexRollout({
      sessionsDir,
      cwd: "/work/other",
      threadId: LIVE_THREAD,
    });
    assert.equal(resolved, live);
    const latest = captureLatestCodexMessage({ logPath: resolved! });
    assert.equal(latest.text, "Latest rendered\nsecond line");
    assert.equal(latest.sessionId, LIVE_THREAD);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("session_meta cwd match prefers the demo rollout over a newer other-cwd file", async () => {
  const { home, sessionsDir, live, dayDir } = await layout();
  const newerOther = join(dayDir, `rollout-2026-06-04T12-00-00-${STALE_THREAD}.jsonl`);
  await copyFile(staleLog, newerOther);
  const later = Date.now() / 1000 + 50;
  await utimes(newerOther, later, later);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(findCodexRolloutByCwd("/work/demo", sessionsDir), live);
    assert.equal(findCodexRolloutByCwd("/work/other", sessionsDir), newerOther);
    const resolved = resolveCodexRollout({ sessionsDir, cwd: "/work/demo" });
    assert.equal(resolved, live);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("without thread id or cwd match, discovery uses the newest rollout", async () => {
  const { sessionsDir, live } = await layout();
  const resolved = resolveCodexRollout({ sessionsDir, cwd: "/no/such/cwd" });
  assert.equal(resolved, live);
});

test("malformed JSON lines are skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-nvimotator-bad-"));
  const path = join(dir, "rollout.jsonl");
  const good = await readFile(liveLog, "utf8");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${good}\nnot valid json\n{broken\n`);
  const latest = getLastCodexMessage(path);
  assert.equal(latest?.text, "Latest rendered\nsecond line");
});
