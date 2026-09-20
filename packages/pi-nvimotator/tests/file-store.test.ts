import assert from "node:assert/strict";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotFromAssistantText } from "../src/assistant-message.ts";
import { FileStore, FileStoreError, MAX_FILE_STORE_ID } from "../src/file-store.ts";
import { markSlotSent } from "./sent-slot.ts";

async function tempStore(prefix = "nvimotator-store-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  const store = new FileStore(root);
  return {
    root,
    store,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function message(text = "Latest rendered\nsecond line") {
  return snapshotFromAssistantText("session-1", "msg_new", text);
}

const comment = "Tighten the greeting";

test("export allocates the lowest free id in 1–99", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const first = await store.exportSnapshot(message("one"));
    const second = await store.exportSnapshot(message("two"));
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    assert.equal(first.snapshotPath, join(store.root, "1", "snapshot.md"));
    assert.match(first.snapshotPath, /^\//);
  } finally {
    await cleanup();
  }
});

test("import frees a slot so the same id can be reused", async () => {
  const { store, cleanup } = await tempStore();
  try {
    const exported = await store.exportSnapshot(message("first"));
    assert.equal(exported.id, 1);
    await markSlotSent(store, 1, comment);
    const imported = await store.importSlot(1);
    assert.equal(imported.id, 1);
    assert.match(imported.annotationPath, /\/1\/annotation\.md$/);
    const reused = await store.exportSnapshot(message("second"));
    assert.equal(reused.id, 1);
    const stored = await store.readStoredSnapshot(1);
    assert.equal(stored?.text, "second");
  } finally {
    await cleanup();
  }
});

test("last pointer is not clobbered when the same id is reused before a new Send", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.exportSnapshot(message("first snapshot"));
    const firstSend = await markSlotSent(store, 1, "first annotation");
    const lastBeforeReuse = await store.last();
    assert.equal(lastBeforeReuse.annotationPath, firstSend.lastPath);
    const firstBody = await (await import("node:fs/promises")).readFile(firstSend.lastPath, "utf8");
    await store.importSlot(1);
    await store.exportSnapshot(message("reused snapshot"));
    const lastAfterReuse = await store.last();
    assert.equal(lastAfterReuse.annotationPath, firstSend.lastPath);
    const bodyAfterReuse = await (await import("node:fs/promises")).readFile(lastAfterReuse.annotationPath, "utf8");
    assert.equal(bodyAfterReuse, firstBody);
    assert.match(bodyAfterReuse, /first annotation/);
    assert.doesNotMatch(bodyAfterReuse, /reused snapshot/);
    await markSlotSent(store, 1, "second annotation");
    const lastAfterSecondSend = await store.last();
    const secondBody = await (await import("node:fs/promises")).readFile(lastAfterSecondSend.annotationPath, "utf8");
    assert.match(secondBody, /second annotation/);
    assert.doesNotMatch(secondBody, /first annotation/);
  } finally {
    await cleanup();
  }
});

test("cancel frees a waiting slot", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.exportSnapshot(message("keep"));
    await store.exportSnapshot(message("drop"));
    await store.cancel(1);
    const reused = await store.exportSnapshot(message("reuse-1"));
    assert.equal(reused.id, 1);
  } finally {
    await cleanup();
  }
});

test("TTL expires an exported slot so it can be reused", async () => {
  let now = 1_000_000;
  const root = await mkdtemp(join(tmpdir(), "nvimotator-ttl-"));
  await chmod(root, 0o700);
  const store = new FileStore(root, { now: () => now, ttlMs: 1_000 });
  try {
    await store.exportSnapshot(message("old"));
    now += 2_000;
    const next = await store.exportSnapshot(message("new"));
    assert.equal(next.id, 1);
    const stored = await store.readStoredSnapshot(1);
    assert.equal(stored?.text, "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full pool reclaims oldest already-sent before refusing", async () => {
  const { store, cleanup } = await tempStore();
  try {
    for (let id = 1; id <= MAX_FILE_STORE_ID; id += 1) {
      await store.exportSnapshot(message(`slot ${id}`));
      await markSlotSent(store, id, `note ${id}`);
    }
    const recycled = await store.exportSnapshot(message("after-full"));
    assert.equal(recycled.id, 1);
    const stored = await store.readStoredSnapshot(1);
    assert.equal(stored?.text, "after-full");
  } finally {
    await cleanup();
  }
});

test("never recycles a slot that is still attached", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.exportSnapshot(message("attached"));
    const lock = join(store.slotDir(1), "attach.lock");
    const handle = await open(lock, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    await chmod(lock, 0o600);
    const next = await store.exportSnapshot(message("other"));
    assert.equal(next.id, 2);
    await assert.rejects(() => store.cancel(1), /still attached/);
  } finally {
    await cleanup();
  }
});

test("last errors when nothing has been sent", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await assert.rejects(() => store.last(), FileStoreError);
    await store.exportSnapshot(message("waiting"));
    await assert.rejects(() => store.last(), /No Nvimotator last annotation/);
  } finally {
    await cleanup();
  }
});

test("directory is created owner-only", async () => {
  const parent = await mkdtemp(join(tmpdir(), "nvimotator-mode-"));
  const root = join(parent, "store");
  try {
    const store = new FileStore(root);
    await store.exportSnapshot(message("mode"));
    const { lstat } = await import("node:fs/promises");
    const dir = await lstat(root);
    assert.equal(dir.mode & 0o777, 0o700);
    const slot = await lstat(store.slotDir(1));
    assert.equal(slot.mode & 0o777, 0o700);
    const snap = await lstat(store.snapshotPath(1));
    assert.equal(snap.mode & 0o777, 0o600);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
