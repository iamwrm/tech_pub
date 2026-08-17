import type Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  MAGAZINE_MAX,
  clearMagazine,
  createMagazineState,
  previewLine,
  type MagazineState,
} from "./magazine.ts";

export const MAGAZINE_DATABASE_FILENAME = "pi-prompt-magazine.sqlite3";
const SCHEMA_VERSION = 2;
/** Bound synchronous lock waits on Pi's UI thread; ordinary writes are tiny. */
const BUSY_TIMEOUT_MS = 250;
const STARTUP_RETRY_MS = 5_000;
const STARTUP_RETRY_DELAY_MS = 25;
const RECOVERY_SCAN_LIMIT = 200;

const require = createRequire(import.meta.url);
type DatabaseConstructor = typeof Database;
type DatabaseInstance = Database.Database;

function loadDatabaseConstructor(): DatabaseConstructor {
  // Keep the native addon lazy: if it is missing or ABI-incompatible, the
  // extension factory still registers its fail-safe input handler and reports
  // an initialization error instead of failing module evaluation.
  return require("better-sqlite3") as DatabaseConstructor;
}

export interface MagazineSessionIdentity {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
}

interface NormalizedIdentity {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
}

export type MagazineLoadOrigin = "existing" | "fork" | "empty";

export interface StoredMagazine {
  state: MagazineState;
  revision: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface LoadedMagazine extends StoredMagazine {
  origin: MagazineLoadOrigin;
}

export interface MagazineMutation<T> {
  state: MagazineState;
  value: T;
  changed: boolean;
}

export interface CommittedMagazineMutation<T> extends StoredMagazine {
  value: T;
  changed: boolean;
}

export interface RecoverableMagazine extends StoredMagazine {
  preview: string;
}

export type RecoverMagazineResult =
  | { kind: "recovered"; magazine: StoredMagazine }
  | { kind: "missing" }
  | { kind: "source-changed" }
  | { kind: "target-not-empty"; magazine: StoredMagazine };

export interface MagazineDurabilitySettings {
  journalMode: string;
  synchronous: number;
  busyTimeoutMs: number;
}

interface MagazineRow {
  session_id: string;
  session_file: string | null;
  cwd: string;
  queue_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

export class MagazineStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MagazineStorageError";
  }
}

export class MagazineStorageCorruptionError extends MagazineStorageError {
  constructor(sessionId: string, message: string, options?: ErrorOptions) {
    super(`Magazine state for session ${sessionId} is invalid: ${message}`, options);
    this.name = "MagazineStorageCorruptionError";
  }
}

function normalizeIdentity(identity: MagazineSessionIdentity): NormalizedIdentity {
  const sessionId = identity.sessionId.trim();
  if (sessionId.length === 0) {
    throw new MagazineStorageError("Cannot persist a magazine without a session ID");
  }
  return {
    sessionId,
    cwd: resolve(identity.cwd),
    sessionFile: identity.sessionFile ? resolve(identity.sessionFile) : undefined,
  };
}

function encodeState(state: MagazineState): string {
  if (!Array.isArray(state.queue) || state.queue.length > MAGAZINE_MAX) {
    throw new MagazineStorageError(`Magazine queue must contain at most ${MAGAZINE_MAX} entries`);
  }
  const ids = new Set<string>();
  for (const entry of state.queue) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new MagazineStorageError("Magazine entry has no stable ID");
    }
    if (ids.has(entry.id)) {
      throw new MagazineStorageError(`Magazine entry ID is duplicated: ${entry.id}`);
    }
    ids.add(entry.id);
    if (typeof entry.text !== "string") {
      throw new MagazineStorageError(`Magazine entry ${entry.id} has invalid text`);
    }
    if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) {
      throw new MagazineStorageError(`Magazine entry ${entry.id} has an invalid creation time`);
    }
  }
  return JSON.stringify({ v: 1, queue: state.queue });
}

function decodeState(sessionId: string, queueJson: string): MagazineState {
  let data: unknown;
  try {
    data = JSON.parse(queueJson);
  } catch (error) {
    throw new MagazineStorageCorruptionError(sessionId, "queue JSON cannot be parsed", { cause: error });
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new MagazineStorageCorruptionError(sessionId, "queue payload is not an object");
  }
  const root = data as Record<string, unknown>;
  if (root.v !== 1 || !Array.isArray(root.queue)) {
    throw new MagazineStorageCorruptionError(sessionId, "queue payload has an unsupported format");
  }
  if (root.queue.length > MAGAZINE_MAX) {
    throw new MagazineStorageCorruptionError(sessionId, `queue exceeds the ${MAGAZINE_MAX}-entry limit`);
  }

  const queue: MagazineState["queue"] = [];
  const ids = new Set<string>();
  for (const raw of root.queue) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new MagazineStorageCorruptionError(sessionId, "queue contains a non-object entry");
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new MagazineStorageCorruptionError(sessionId, "queue contains an entry without a stable ID");
    }
    if (ids.has(entry.id)) {
      throw new MagazineStorageCorruptionError(sessionId, `queue contains duplicate entry ID ${entry.id}`);
    }
    ids.add(entry.id);
    if (typeof entry.text !== "string") {
      throw new MagazineStorageCorruptionError(sessionId, `entry ${entry.id} has invalid text`);
    }
    if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) {
      throw new MagazineStorageCorruptionError(sessionId, `entry ${entry.id} has an invalid creation time`);
    }
    queue.push({ id: entry.id, text: entry.text, createdAt: entry.createdAt });
  }
  return { queue };
}

function rowToStored(row: MagazineRow): StoredMagazine {
  return {
    state: decodeState(row.session_id, row.queue_json),
    revision: row.revision,
    sessionId: row.session_id,
    sessionFile: row.session_file ?? undefined,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY");
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function retryStartup<T>(operation: () => T): T {
  const deadline = Date.now() + STARTUP_RETRY_MS;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      sleepSync(STARTUP_RETRY_DELAY_MS);
    }
  }
}

function assertSafeDatabasePath(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new MagazineStorageError(`Magazine database path is not a regular file: ${path}`);
  }
  if (process.platform !== "win32") {
    if (stat.nlink !== 1) {
      throw new MagazineStorageError(`Magazine database path has unexpected hard links: ${path}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new MagazineStorageError(`Magazine database is not owned by the current user: ${path}`);
    }
  }
}

function setOwnerOnly(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if (process.platform !== "win32") {
      throw new MagazineStorageError(`Cannot restrict magazine database permissions: ${path}`, { cause: error });
    }
  }
}

const CREATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS magazines (
    session_id TEXT NOT NULL,
    session_file TEXT,
    cwd TEXT NOT NULL,
    queue_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (cwd, session_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS magazines_session_file_idx
    ON magazines(session_file);
  CREATE INDEX IF NOT EXISTS magazines_cwd_updated_idx
    ON magazines(cwd, updated_at DESC);
`;

/**
 * SQLite-backed magazine storage. Every mutation rereads the current row while
 * holding an IMMEDIATE transaction, so separate Pi processes cannot overwrite
 * one another with stale in-memory queue snapshots.
 */
export class MagazineStorage {
  readonly databasePath: string;
  private readonly db: DatabaseInstance;

  constructor(databasePath: string) {
    this.databasePath = resolve(databasePath);
    let opened: DatabaseInstance | undefined;
    try {
      mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
      assertSafeDatabasePath(this.databasePath);

      const DatabaseClass = loadDatabaseConstructor();
      const previousUmask = process.umask(0o077);
      try {
        opened = new DatabaseClass(this.databasePath, { timeout: BUSY_TIMEOUT_MS });
      } finally {
        process.umask(previousUmask);
      }
      this.db = opened;

      // Recheck after open to reject pre-existing or raced symlink/hardlink paths
      // before issuing any write-capable PRAGMA or schema statement.
      assertSafeDatabasePath(this.databasePath);
      setOwnerOnly(this.databasePath);
      this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      retryStartup(() => {
        const mode = this.db.pragma("journal_mode = WAL", { simple: true });
        if (String(mode).toLowerCase() !== "wal") {
          throw new MagazineStorageError(`SQLite refused WAL journal mode (reported ${String(mode)})`);
        }
      });
      this.db.pragma("synchronous = FULL");
      this.db.pragma("foreign_keys = ON");
      retryStartup(() => this.initializeSchema());
    } catch (error) {
      try {
        if (opened?.open) opened.close();
      } catch {
        // Preserve the initialization error.
      }
      throw new MagazineStorageError(`Cannot open magazine database at ${this.databasePath}`, { cause: error });
    }
  }

  private initializeSchema(): void {
    const version = this.db.pragma("user_version", { simple: true });
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new MagazineStorageError("Cannot read magazine database schema version");
    }
    if (version !== 0 && version !== SCHEMA_VERSION) {
      throw new MagazineStorageError(
        `Magazine database schema ${version} is unsupported; expected schema ${SCHEMA_VERSION}`,
      );
    }

    this.db.exec(CREATE_SCHEMA_SQL);
    if (version === 0) this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private getRow(identity: NormalizedIdentity): MagazineRow | undefined {
    return this.db
      .prepare<[string, string], MagazineRow>(
        "SELECT * FROM magazines WHERE cwd = ? AND session_id = ?",
      )
      .get(identity.cwd, identity.sessionId);
  }

  private getRowBySessionFile(sessionFile: string, exclude: NormalizedIdentity): MagazineRow | undefined {
    return this.db
      .prepare<[string, string, string], MagazineRow>(
        `SELECT * FROM magazines
         WHERE session_file = ? AND NOT (cwd = ? AND session_id = ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(resolve(sessionFile), exclude.cwd, exclude.sessionId);
  }

  load(identityInput: MagazineSessionIdentity): StoredMagazine | undefined {
    const identity = normalizeIdentity(identityInput);
    const row = this.getRow(identity);
    return row ? rowToStored(row) : undefined;
  }

  loadRevision(identityInput: MagazineSessionIdentity): number | undefined {
    const identity = normalizeIdentity(identityInput);
    const row = this.db
      .prepare<[string, string], { revision: number }>(
        "SELECT revision FROM magazines WHERE cwd = ? AND session_id = ?",
      )
      .get(identity.cwd, identity.sessionId);
    return row?.revision;
  }

  getDurabilitySettings(): MagazineDurabilitySettings {
    const journalMode = this.db.pragma("journal_mode", { simple: true });
    const synchronous = this.db.pragma("synchronous", { simple: true });
    const busyTimeout = this.db.pragma("busy_timeout", { simple: true });
    if (typeof journalMode !== "string" || typeof synchronous !== "number" || typeof busyTimeout !== "number") {
      throw new MagazineStorageError("Cannot read magazine durability settings");
    }
    return { journalMode, synchronous, busyTimeoutMs: busyTimeout };
  }

  loadOrCreate(
    identityInput: MagazineSessionIdentity,
    options: {
      cloneFromSessionFile?: string;
      now?: number;
    } = {},
  ): LoadedMagazine {
    const identity = normalizeIdentity(identityInput);

    // Common reload/resume path: avoid taking the global SQLite writer lock
    // when neither queue nor metadata needs to change.
    const fastExisting = this.getRow(identity);
    if (fastExisting && fastExisting.session_file === (identity.sessionFile ?? null)) {
      return { ...rowToStored(fastExisting), origin: "existing" };
    }

    const transaction = this.db.transaction((): LoadedMagazine => {
      const timestamp = options.now ?? Date.now();
      const existing = this.getRow(identity);
      if (existing) {
        if (existing.session_file !== (identity.sessionFile ?? null)) {
          this.db
            .prepare(
              `UPDATE magazines SET session_file = ?
               WHERE cwd = ? AND session_id = ?`,
            )
            .run(identity.sessionFile ?? null, identity.cwd, identity.sessionId);
        }
        return {
          ...rowToStored({ ...existing, session_file: identity.sessionFile ?? null }),
          origin: "existing",
        };
      }

      let state = createMagazineState();
      let origin: MagazineLoadOrigin = "empty";
      if (options.cloneFromSessionFile) {
        const source = this.getRowBySessionFile(options.cloneFromSessionFile, identity);
        if (source) {
          state = rowToStored(source).state;
          origin = "fork";
        }
      }
      this.db
        .prepare(
          `INSERT INTO magazines (
             session_id, session_file, cwd, queue_json, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          identity.sessionId,
          identity.sessionFile ?? null,
          identity.cwd,
          encodeState(state),
          timestamp,
          timestamp,
        );
      const inserted = this.getRow(identity);
      if (!inserted) throw new MagazineStorageError("Magazine row disappeared after insertion");
      return { ...rowToStored(inserted), origin };
    });
    return transaction.immediate();
  }

  mutate<T>(
    identityInput: MagazineSessionIdentity,
    mutation: (state: MagazineState) => MagazineMutation<T>,
    now?: number,
  ): CommittedMagazineMutation<T> {
    const identity = normalizeIdentity(identityInput);
    const transaction = this.db.transaction((): CommittedMagazineMutation<T> => {
      const timestamp = now ?? Date.now();
      let row = this.getRow(identity);
      if (!row) {
        this.db
          .prepare(
            `INSERT INTO magazines (
               session_id, session_file, cwd, queue_json, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            identity.sessionId,
            identity.sessionFile ?? null,
            identity.cwd,
            encodeState(createMagazineState()),
            timestamp,
            timestamp,
          );
        row = this.getRow(identity);
      }
      if (!row) throw new MagazineStorageError("Magazine row is unavailable during mutation");

      const current = rowToStored(row);
      const result = mutation(current.state);
      let revision = current.revision;
      let updatedAt = current.updatedAt;
      let state = current.state;

      if (result.changed) {
        const queueJson = encodeState(result.state);
        revision += 1;
        updatedAt = timestamp;
        this.db
          .prepare(
            `UPDATE magazines
             SET session_file = ?, queue_json = ?, revision = ?, updated_at = ?
             WHERE cwd = ? AND session_id = ?`,
          )
          .run(
            identity.sessionFile ?? null,
            queueJson,
            revision,
            updatedAt,
            identity.cwd,
            identity.sessionId,
          );
        state = result.state;
      } else if (row.session_file !== (identity.sessionFile ?? null)) {
        this.db
          .prepare(
            `UPDATE magazines SET session_file = ?
             WHERE cwd = ? AND session_id = ?`,
          )
          .run(identity.sessionFile ?? null, identity.cwd, identity.sessionId);
      }

      return {
        state,
        revision,
        sessionId: identity.sessionId,
        sessionFile: identity.sessionFile,
        cwd: identity.cwd,
        createdAt: current.createdAt,
        updatedAt,
        value: result.value,
        changed: result.changed,
      };
    });
    return transaction.immediate();
  }

  listRecoverable(cwdInput: string, excludeSessionId: string): RecoverableMagazine[] {
    const cwd = resolve(cwdInput);
    const rows = this.db
      .prepare<[string, string, number], MagazineRow>(
        `SELECT * FROM magazines
         WHERE cwd = ? AND session_id <> ?
           AND json_array_length(queue_json, '$.queue') > 0
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(cwd, excludeSessionId, RECOVERY_SCAN_LIMIT);

    const recoverable: RecoverableMagazine[] = [];
    for (const row of rows) {
      const stored = rowToStored(row);
      if (stored.sessionFile && existsSync(stored.sessionFile)) continue;
      recoverable.push({
        ...stored,
        preview: previewLine(stored.state.queue[0]?.text ?? "", 64),
      });
    }
    return recoverable;
  }

  recoverInto(
    sourceExpected: RecoverableMagazine,
    targetInput: MagazineSessionIdentity,
    now?: number,
  ): RecoverMagazineResult {
    const target = normalizeIdentity(targetInput);
    const source = normalizeIdentity(sourceExpected);
    if (source.sessionId === target.sessionId && source.cwd === target.cwd) return { kind: "missing" };
    if (source.cwd !== target.cwd) return { kind: "source-changed" };

    const transaction = this.db.transaction((): RecoverMagazineResult => {
      const timestamp = now ?? Date.now();
      const sourceRow = this.getRow(source);
      if (!sourceRow) return { kind: "missing" };
      if (
        sourceRow.revision !== sourceExpected.revision ||
        sourceRow.session_file !== (source.sessionFile ?? null) ||
        (source.sessionFile !== undefined && existsSync(source.sessionFile))
      ) {
        return { kind: "source-changed" };
      }
      const storedSource = rowToStored(sourceRow);
      if (storedSource.state.queue.length === 0) return { kind: "missing" };

      let targetRow = this.getRow(target);
      if (!targetRow) {
        this.db
          .prepare(
            `INSERT INTO magazines (
               session_id, session_file, cwd, queue_json, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            target.sessionId,
            target.sessionFile ?? null,
            target.cwd,
            encodeState(createMagazineState()),
            timestamp,
            timestamp,
          );
        targetRow = this.getRow(target);
      }
      if (!targetRow) throw new MagazineStorageError("Recovery target row is unavailable");
      const currentTarget = rowToStored(targetRow);
      if (currentTarget.state.queue.length > 0) {
        return { kind: "target-not-empty", magazine: currentTarget };
      }

      const targetRevision = currentTarget.revision + 1;
      this.db
        .prepare(
          `UPDATE magazines
           SET session_file = ?, queue_json = ?, revision = ?, updated_at = ?
           WHERE cwd = ? AND session_id = ?`,
        )
        .run(
          target.sessionFile ?? null,
          encodeState(storedSource.state),
          targetRevision,
          timestamp,
          target.cwd,
          target.sessionId,
        );
      this.db
        .prepare(
          `UPDATE magazines
           SET queue_json = ?, revision = revision + 1, updated_at = ?
           WHERE cwd = ? AND session_id = ?`,
        )
        .run(encodeState(clearMagazine()), timestamp, source.cwd, source.sessionId);

      return {
        kind: "recovered",
        magazine: {
          state: storedSource.state,
          revision: targetRevision,
          sessionId: target.sessionId,
          sessionFile: target.sessionFile,
          cwd: target.cwd,
          createdAt: currentTarget.createdAt,
          updatedAt: timestamp,
        },
      };
    });
    return transaction.immediate();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
