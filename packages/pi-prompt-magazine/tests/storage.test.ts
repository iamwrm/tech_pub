import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { pushStash } from "../magazine.ts";
import {
  MagazineStorage,
  MagazineStorageCorruptionError,
  type MagazineSessionIdentity,
} from "../storage.ts";

const workerPath = fileURLToPath(new URL("./storage-worker.ts", import.meta.url));

function fixture(): { dir: string; databasePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-prompt-magazine-"));
  return {
    dir,
    databasePath: join(dir, "magazine.sqlite3"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function identity(dir: string, sessionId: string, sessionFile = join(dir, `${sessionId}.jsonl`)): MagazineSessionIdentity {
  return { sessionId, cwd: dir, sessionFile };
}

function add(storage: MagazineStorage, session: MagazineSessionIdentity, text: string): void {
  storage.mutate(session, (current) => {
    const result = pushStash(current, text);
    return { state: result.state, value: undefined, changed: true };
  });
}

function runWorker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, ...args], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15_000);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`worker failed (${code ?? signal})\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

test("SQLite state survives close/reopen", () => {
  const f = fixture();
  try {
    const session = identity(f.dir, "session-a");
    const first = new MagazineStorage(f.databasePath);
    const created = first.loadOrCreate(session);
    assert.equal(created.origin, "empty");
    add(first, session, "persist me");
    first.close();

    const reopened = new MagazineStorage(f.databasePath);
    const loaded = reopened.loadOrCreate(session);
    assert.equal(loaded.origin, "existing");
    assert.deepEqual(loaded.state.queue.map((entry) => entry.text), ["persist me"]);
    assert.equal(loaded.revision, 1);
    reopened.close();
  } finally {
    f.cleanup();
  }
});

test("magazines are isolated by Pi session ID", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const a = identity(f.dir, "session-a");
    const b = identity(f.dir, "session-b");
    storage.loadOrCreate(a);
    storage.loadOrCreate(b);
    add(storage, a, "only a");
    add(storage, b, "only b");
    assert.deepEqual(storage.load(a)?.state.queue.map((entry) => entry.text), ["only a"]);
    assert.deepEqual(storage.load(b)?.state.queue.map((entry) => entry.text), ["only b"]);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("the same user-selected session ID is isolated between working directories", () => {
  const f = fixture();
  try {
    const otherCwd = join(f.dir, "other-project");
    const storage = new MagazineStorage(f.databasePath);
    const first = identity(f.dir, "shared-name");
    const second = identity(otherCwd, "shared-name");
    storage.loadOrCreate(first);
    storage.loadOrCreate(second);
    add(storage, first, "project one");
    add(storage, second, "project two");
    assert.deepEqual(storage.load(first)?.state.queue.map((entry) => entry.text), ["project one"]);
    assert.deepEqual(storage.load(second)?.state.queue.map((entry) => entry.text), ["project two"]);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("SQLite durability and UI lock-wait settings are applied", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.getDurabilitySettings(), {
      journalMode: "wal",
      synchronous: 2,
      busyTimeoutMs: 250,
    });
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("schema v1 is rejected without modifying its stored queue", () => {
  const f = fixture();
  try {
    const raw = new Database(f.databasePath);
    raw.exec(`
      CREATE TABLE magazines (
        session_id TEXT PRIMARY KEY,
        session_file TEXT,
        cwd TEXT NOT NULL,
        queue_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX magazines_session_file_idx ON magazines(session_file);
      CREATE INDEX magazines_cwd_updated_idx ON magazines(cwd, updated_at DESC);
      PRAGMA user_version = 1;
    `);
    const queueJson = JSON.stringify({
      v: 1,
      queue: [{ id: "legacy-id", text: "preserve schema-one data", createdAt: 123 }],
    });
    raw.prepare(
      "INSERT INTO magazines VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("v1-session", join(f.dir, "v1.jsonl"), f.dir, queueJson, 7, 100, 200);
    raw.close();

    assert.throws(
      () => new MagazineStorage(f.databasePath),
      (error: unknown) => {
        const cause = error instanceof Error ? error.cause : undefined;
        return cause instanceof Error && cause.message.includes("schema 1 is unsupported");
      },
    );

    const verify = new Database(f.databasePath);
    assert.equal(verify.pragma("user_version", { simple: true }), 1);
    const preserved = verify.prepare("SELECT queue_json, revision FROM magazines WHERE session_id = ?")
      .get("v1-session") as { queue_json: string; revision: number };
    assert.equal(JSON.parse(preserved.queue_json).queue[0].text, "preserve schema-one data");
    assert.equal(preserved.revision, 7);
    verify.close();
  } finally {
    f.cleanup();
  }
});

test("fork creation copies the parent queue once and then diverges", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const parent = identity(f.dir, "parent", join(f.dir, "parent.jsonl"));
    const child = identity(f.dir, "child", join(f.dir, "child.jsonl"));
    storage.loadOrCreate(parent);
    add(storage, parent, "inherited");

    const fork = storage.loadOrCreate(child, { cloneFromSessionFile: parent.sessionFile });
    assert.equal(fork.origin, "fork");
    assert.deepEqual(fork.state.queue.map((entry) => entry.text), ["inherited"]);
    add(storage, child, "child only");
    add(storage, parent, "parent only");

    assert.deepEqual(storage.load(parent)?.state.queue.map((entry) => entry.text), [
      "inherited",
      "parent only",
    ]);
    assert.deepEqual(storage.load(child)?.state.queue.map((entry) => entry.text), [
      "inherited",
      "child only",
    ]);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("separate connections reread inside each transaction instead of overwriting stale state", () => {
  const f = fixture();
  try {
    const session = identity(f.dir, "shared");
    const first = new MagazineStorage(f.databasePath);
    const second = new MagazineStorage(f.databasePath);
    first.loadOrCreate(session);
    add(first, session, "from first");
    add(second, session, "from second");
    assert.deepEqual(first.load(session)?.state.queue.map((entry) => entry.text), [
      "from first",
      "from second",
    ]);
    first.close();
    second.close();
  } finally {
    f.cleanup();
  }
});

test("concurrent first opens initialize WAL/schema and preserve independent writes", async () => {
  const f = fixture();
  try {
    const session = identity(f.dir, "concurrent", join(f.dir, "concurrent.jsonl"));
    await Promise.all(
      ["alpha", "beta", "gamma"].map((prefix) =>
        runWorker([
          f.databasePath,
          session.sessionId,
          session.cwd,
          session.sessionFile ?? "",
          prefix,
          "10",
        ]),
      ),
    );

    const storage = new MagazineStorage(f.databasePath);
    const texts = storage.load(session)?.state.queue.map((entry) => entry.text) ?? [];
    assert.equal(texts.length, 30);
    assert.equal(new Set(texts).size, 30);
    for (const prefix of ["alpha", "beta", "gamma"]) {
      for (let i = 0; i < 10; i++) assert.ok(texts.includes(`${prefix}-${i}`));
    }
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("a committed write survives process exit without an explicit database close", async () => {
  const f = fixture();
  try {
    const session = identity(f.dir, "crash", join(f.dir, "crash.jsonl"));
    await runWorker([
      f.databasePath,
      session.sessionId,
      session.cwd,
      session.sessionFile ?? "",
      "durable",
      "1",
      "exit-without-close",
    ]);
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.load(session)?.state.queue.map((entry) => entry.text), ["durable-0"]);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("orphan recovery transfers a non-empty missing-file queue into an empty target", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const orphan = identity(f.dir, "orphan", join(f.dir, "never-written.jsonl"));
    const target = identity(f.dir, "target", join(f.dir, "target.jsonl"));
    storage.loadOrCreate(orphan);
    storage.loadOrCreate(target);
    add(storage, orphan, "recover me");

    const candidates = storage.listRecoverable(f.dir, target.sessionId);
    assert.deepEqual(candidates.map((candidate) => candidate.sessionId), [orphan.sessionId]);
    const result = storage.recoverInto(candidates[0], target);
    assert.equal(result.kind, "recovered");
    if (result.kind === "recovered") {
      assert.deepEqual(result.magazine.state.queue.map((entry) => entry.text), ["recover me"]);
    }
    assert.deepEqual(storage.load(orphan)?.state.queue, []);
    assert.deepEqual(storage.load(target)?.state.queue.map((entry) => entry.text), ["recover me"]);
    assert.deepEqual(storage.listRecoverable(f.dir, target.sessionId), []);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("recovery refuses to overwrite a target changed by another process", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const source = identity(f.dir, "source");
    const target = identity(f.dir, "target");
    storage.loadOrCreate(source);
    storage.loadOrCreate(target);
    add(storage, source, "source draft");
    add(storage, target, "target draft");
    const [candidate] = storage.listRecoverable(f.dir, target.sessionId);
    const result = storage.recoverInto(candidate, target);
    assert.equal(result.kind, "target-not-empty");
    assert.deepEqual(storage.load(source)?.state.queue.map((entry) => entry.text), ["source draft"]);
    assert.deepEqual(storage.load(target)?.state.queue.map((entry) => entry.text), ["target draft"]);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("recovery revalidates a selected source revision", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const source = identity(f.dir, "source-race", join(f.dir, "missing.jsonl"));
    const target = identity(f.dir, "target-race");
    storage.loadOrCreate(source);
    storage.loadOrCreate(target);
    add(storage, source, "selected version");
    const [candidate] = storage.listRecoverable(f.dir, target.sessionId);
    add(storage, source, "new version");
    assert.equal(storage.recoverInto(candidate, target).kind, "source-changed");
    assert.deepEqual(storage.load(target)?.state.queue, []);
    assert.deepEqual(storage.load(source)?.state.queue.map((entry) => entry.text), ["selected version", "new version"]);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("recovery revalidates that the selected source is still orphaned", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const source = identity(f.dir, "resumable-race", join(f.dir, "appears.jsonl"));
    const target = identity(f.dir, "resumable-target");
    storage.loadOrCreate(source);
    storage.loadOrCreate(target);
    add(storage, source, "belongs to session file");
    const [candidate] = storage.listRecoverable(f.dir, target.sessionId);
    writeFileSync(source.sessionFile!, "{}\n", "utf8");
    assert.equal(storage.recoverInto(candidate, target).kind, "source-changed");
    assert.deepEqual(storage.load(target)?.state.queue, []);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("rows whose Pi session file exists are not offered as orphan recovery candidates", () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    const existingFile = join(f.dir, "persisted.jsonl");
    writeFileSync(existingFile, "{}\n", "utf8");
    const persisted = identity(f.dir, "persisted", existingFile);
    const target = identity(f.dir, "target");
    storage.loadOrCreate(persisted);
    storage.loadOrCreate(target);
    add(storage, persisted, "belongs to resumable session");
    assert.deepEqual(storage.listRecoverable(f.dir, target.sessionId), []);
    storage.close();
  } finally {
    f.cleanup();
  }
});

test("malformed queue JSON fails loudly instead of silently replacing drafts", () => {
  const f = fixture();
  try {
    const session = identity(f.dir, "corrupt");
    const storage = new MagazineStorage(f.databasePath);
    storage.loadOrCreate(session);
    storage.close();

    const raw = new Database(f.databasePath);
    raw.prepare("UPDATE magazines SET queue_json = ? WHERE session_id = ?").run("{not json", session.sessionId);
    raw.close();

    const reopened = new MagazineStorage(f.databasePath);
    assert.throws(() => reopened.load(session), MagazineStorageCorruptionError);
    reopened.close();
  } finally {
    f.cleanup();
  }
});

test("database file is owner-only on POSIX systems", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const storage = new MagazineStorage(f.databasePath);
    storage.close();
    assert.equal(statSync(f.databasePath).mode & 0o777, 0o600);
  } finally {
    // Keep cleanup possible even if a hostile umask/platform changed the mode.
    try {
      chmodSync(f.databasePath, 0o600);
    } catch {
      // Ignore cleanup preparation failure.
    }
    f.cleanup();
  }
});
