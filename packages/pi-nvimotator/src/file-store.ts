import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import type { MessageSnapshot } from "./assistant-message.ts";
import { QUICK_ACTIONS } from "./protocol.ts";

export const FILE_STORE_ENV = "NVIMOTATOR_STORE";
export const MAX_FILE_STORE_ID = 99;
export const SLOT_TTL_MS = 24 * 60 * 60 * 1000;
export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

export type SlotStatus = "exported" | "sent" | "imported" | "cancelled";

export interface SlotMeta {
  id: number;
  status: SlotStatus;
  kind: MessageSnapshot["kind"];
  sessionId: string;
  entryId: string;
  snapshotId: string;
  messageHash: string;
  filePath?: string;
  createdAt: string;
  sentAt?: string;
  importedAt?: string;
}

export interface StoredSnapshot {
  kind: MessageSnapshot["kind"];
  sessionId: string;
  entryId: string;
  snapshotId: string;
  messageHash: string;
  text: string;
  lines: string[];
  filePath?: string;
  quickActions: typeof QUICK_ACTIONS;
}

export interface ExportResult {
  id: number;
  snapshotPath: string;
  slotDir: string;
}

export interface AnnotationResult {
  id: number;
  annotationPath: string;
  lastPath: string;
}

export class FileStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileStoreError";
  }
}

export function defaultStoreRoot(): string {
  return process.env[FILE_STORE_ENV]
    ? resolve(process.env[FILE_STORE_ENV]!)
    : join(process.env.HOME || process.env.USERPROFILE || homedir(), ".nvimotator");
}

function livePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FileStoreError(`Nvimotator store path is not a safe directory: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new FileStoreError(`Nvimotator store directory is not owned by the current user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new FileStoreError(`Nvimotator store directory permissions must already be owner-only: ${path}`);
  }
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, FILE_MODE);
  await rename(temporary, path);
  await chmod(path, FILE_MODE);
}

async function removeTree(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new FileStoreError(`Refusing to follow a symbolic link in the Nvimotator store: ${path}`);
  }
  if (stat.isDirectory()) {
    const entries = await readdir(path);
    for (const name of entries) await removeTree(join(path, name));
    await rmdir(path);
    return;
  }
  await unlink(path);
}

function canonicalId(raw: string | number): number | undefined {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 1 && raw <= MAX_FILE_STORE_ID ? raw : undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const id = Number.parseInt(raw, 10);
  return id >= 1 && id <= MAX_FILE_STORE_ID ? id : undefined;
}

function toStoredSnapshot(snapshot: MessageSnapshot): StoredSnapshot {
  return {
    kind: snapshot.kind,
    sessionId: snapshot.sessionId,
    entryId: snapshot.entryId,
    snapshotId: snapshot.snapshotId,
    messageHash: snapshot.messageHash,
    text: snapshot.text,
    lines: [...snapshot.lines],
    ...(snapshot.filePath ? { filePath: snapshot.filePath } : {}),
    quickActions: QUICK_ACTIONS,
  };
}

export class FileStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(root: string, options: { now?: () => number; ttlMs?: number } = {}) {
    this.root = resolve(root);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SLOT_TTL_MS;
  }

  static fromEnv(options: { now?: () => number; ttlMs?: number } = {}): FileStore {
    return new FileStore(defaultStoreRoot(), options);
  }

  slotDir(id: number): string {
    return join(this.root, String(id));
  }

  snapshotPath(id: number): string {
    return join(this.slotDir(id), "snapshot.md");
  }

  annotationPath(id: number): string {
    return join(this.slotDir(id), "annotation.md");
  }

  lastAnnotationPath(): string {
    return join(this.root, "last", "annotation.md");
  }

  async ensureRoot(): Promise<void> {
    let existed = true;
    try {
      await lstat(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    if (!existed) await chmod(this.root, DIRECTORY_MODE);
    await assertPrivateDirectory(this.root);
  }

  async exportSnapshot(snapshot: MessageSnapshot): Promise<ExportResult> {
    if (!snapshot.text.trim()) throw new FileStoreError("Refusing to export an empty snapshot.");
    await this.ensureRoot();
    const id = await this.allocateId();
    try {
      const slotDir = this.slotDir(id);
      const stored = toStoredSnapshot(snapshot);
      const meta: SlotMeta = {
        id,
        status: "exported",
        kind: snapshot.kind,
        sessionId: snapshot.sessionId,
        entryId: snapshot.entryId,
        snapshotId: snapshot.snapshotId,
        messageHash: snapshot.messageHash,
        ...(snapshot.filePath ? { filePath: snapshot.filePath } : {}),
        createdAt: new Date(this.now()).toISOString(),
      };
      await mkdir(slotDir, { recursive: true, mode: DIRECTORY_MODE });
      await chmod(slotDir, DIRECTORY_MODE);
      await writePrivateFile(this.snapshotPath(id), snapshot.text.endsWith("\n") ? snapshot.text : `${snapshot.text}\n`);
      await writePrivateFile(join(slotDir, "snapshot.json"), `${JSON.stringify(stored, null, 2)}\n`);
      await writePrivateFile(join(slotDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
      return { id, snapshotPath: resolve(this.snapshotPath(id)), slotDir: resolve(slotDir) };
    } finally {
      await this.releaseAllocLock(id);
    }
  }

  async importSlot(id?: number): Promise<AnnotationResult> {
    const resolved = id === undefined ? await this.newestSentId() : canonicalId(id);
    if (resolved === undefined) {
      throw new FileStoreError(id === undefined
        ? "No sent Nvimotator annotation is waiting to be imported."
        : "Import ID must be an integer from 1 to 99.");
    }
    const meta = await this.readMeta(resolved);
    if (!meta) throw new FileStoreError(`Nvimotator slot ${resolved} does not exist.`);
    if (meta.status !== "sent" && meta.status !== "imported") {
      throw new FileStoreError(`Nvimotator slot ${resolved} has no annotation yet.`);
    }
    const annotationPath = this.annotationPath(resolved);
    try {
      await lstat(annotationPath);
    } catch {
      throw new FileStoreError(`Nvimotator slot ${resolved} has no annotation file.`);
    }
    if (meta.status === "sent") {
      const next: SlotMeta = {
        ...meta,
        status: "imported",
        importedAt: new Date(this.now()).toISOString(),
      };
      await writePrivateFile(join(this.slotDir(resolved), "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
    }
    return {
      id: resolved,
      annotationPath: resolve(annotationPath),
      lastPath: resolve(this.lastAnnotationPath()),
    };
  }

  async last(): Promise<{ annotationPath: string }> {
    const annotationPath = this.lastAnnotationPath();
    try {
      const stat = await lstat(annotationPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new FileStoreError("Nvimotator last annotation path is not a regular file.");
      }
    } catch (error) {
      if (error instanceof FileStoreError) throw error;
      throw new FileStoreError("No Nvimotator last annotation has been sent yet.");
    }
    return { annotationPath: resolve(annotationPath) };
  }

  async cancel(id: number): Promise<void> {
    const canonical = canonicalId(id);
    if (canonical === undefined) throw new FileStoreError("Cancel ID must be an integer from 1 to 99.");
    if (await this.isAttached(canonical)) {
      throw new FileStoreError(`Nvimotator slot ${canonical} is still attached in Neovim.`);
    }
    const meta = await this.readMeta(canonical);
    if (!meta) throw new FileStoreError(`Nvimotator slot ${canonical} does not exist.`);
    if (meta.status === "imported" || meta.status === "cancelled") return;
    const next: SlotMeta = { ...meta, status: "cancelled" };
    await writePrivateFile(join(this.slotDir(canonical), "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  }

  async readMeta(id: number): Promise<SlotMeta | undefined> {
    try {
      const raw = await readFile(join(this.slotDir(id), "meta.json"), "utf8");
      const parsed = JSON.parse(raw) as SlotMeta;
      if (!parsed || parsed.id !== id) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async readStoredSnapshot(id: number): Promise<StoredSnapshot | undefined> {
    try {
      return JSON.parse(await readFile(join(this.slotDir(id), "snapshot.json"), "utf8")) as StoredSnapshot;
    } catch {
      return undefined;
    }
  }

  parseLocator(raw: string): number | undefined {
    const trimmed = raw.trim();
    const direct = canonicalId(trimmed);
    if (direct !== undefined) return direct;
    const normalized = trimmed.replace(/\\/g, "/");
    const match = /(?:^|\/)(\d{1,2})(?:\/snapshot\.md)?$/.exec(normalized);
    if (!match) return undefined;
    return canonicalId(match[1]!);
  }

  private async allocateId(): Promise<number> {
    for (let round = 0; round < 3; round += 1) {
      const inspection = await this.inspectSlots();
      const candidates = this.candidateIds(inspection, round);
      for (const id of candidates) {
        if (await this.isAttached(id)) continue;
        if (!(await this.claimAllocLock(id))) continue;
        try {
          if (await this.isAttached(id)) {
            await this.releaseAllocLock(id);
            continue;
          }
          const fresh = await this.readMeta(id);
          const current = { id, meta: fresh, attached: false };
          if (fresh && !this.isReclaimable(current, round) && this.isOccupied(current)) {
            await this.releaseAllocLock(id);
            continue;
          }
          await removeTree(this.slotDir(id));
          return id;
        } catch (error) {
          await this.releaseAllocLock(id).catch(() => undefined);
          throw error;
        }
      }
    }
    throw new FileStoreError("Nvimotator file-store IDs 1–99 are all in use (locked, attached, or waiting).");
  }

  private candidateIds(inspection: Map<number, InspectedSlot>, round: number): number[] {
    const lowestFree: number[] = [];
    for (let id = 1; id <= MAX_FILE_STORE_ID; id += 1) {
      const slot = inspection.get(id);
      if (!slot || this.isFree(slot) || this.isReclaimable(slot, round)) lowestFree.push(id);
    }
    if (round === 0) return lowestFree;
    if (round === 1) {
      const imported = [...inspection.values()]
        .filter((slot) => slot.meta?.status === "imported")
        .map((slot) => slot.id)
        .sort((left, right) => left - right);
      return [...imported, ...lowestFree.filter((id) => !imported.includes(id))];
    }
    const sent = [...inspection.values()]
      .filter((slot) => slot.meta?.status === "sent" && !slot.attached)
      .sort((left, right) => {
        const leftTime = Date.parse(left.meta?.sentAt ?? left.meta?.createdAt ?? "") || 0;
        const rightTime = Date.parse(right.meta?.sentAt ?? right.meta?.createdAt ?? "") || 0;
        return leftTime - rightTime;
      })
      .map((slot) => slot.id);
    return [...sent, ...lowestFree.filter((id) => !sent.includes(id))];
  }

  private isOccupied(slot: InspectedSlot): boolean {
    if (slot.attached) return true;
    const status = slot.meta?.status;
    if (!status || status === "imported" || status === "cancelled") return false;
    if (status === "exported" && this.isExpired(slot.meta)) return false;
    return status === "exported" || status === "sent";
  }

  private isFree(slot: InspectedSlot): boolean {
    return !this.isOccupied(slot);
  }

  private isReclaimable(slot: InspectedSlot, round: number): boolean {
    if (slot.attached) return false;
    if (!slot.meta) return true;
    if (slot.meta.status === "exported" && this.isExpired(slot.meta)) return true;
    if (round >= 1 && slot.meta.status === "imported") return true;
    if (round >= 2 && slot.meta.status === "sent") return true;
    return slot.meta.status === "cancelled";
  }

  private isExpired(meta: SlotMeta | undefined): boolean {
    if (!meta) return false;
    const created = Date.parse(meta.createdAt);
    if (!Number.isFinite(created)) return false;
    return this.now() - created >= this.ttlMs;
  }

  private async inspectSlots(): Promise<Map<number, InspectedSlot>> {
    const result = new Map<number, InspectedSlot>();
    let names: string[] = [];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    for (const name of names) {
      const id = canonicalId(name);
      if (id === undefined) continue;
      result.set(id, {
        id,
        meta: await this.readMeta(id),
        attached: await this.isAttached(id),
      });
    }
    return result;
  }

  private async newestSentId(): Promise<number | undefined> {
    const inspection = await this.inspectSlots();
    const sent = [...inspection.values()]
      .filter((slot) => slot.meta?.status === "sent")
      .sort((left, right) => {
        const leftTime = Date.parse(left.meta?.sentAt ?? "") || 0;
        const rightTime = Date.parse(right.meta?.sentAt ?? "") || 0;
        return rightTime - leftTime;
      });
    return sent[0]?.id;
  }

  async isAttached(id: number): Promise<boolean> {
    const lockPath = join(this.slotDir(id), "attach.lock");
    try {
      const stat = await lstat(lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      const pid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
      if (!livePid(pid)) {
        await unlink(lockPath).catch(() => undefined);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private allocLockPath(id: number): string {
    return join(this.root, `${id}.lock`);
  }

  private async claimAllocLock(id: number): Promise<boolean> {
    const path = this.allocLockPath(id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await open(path, "wx", FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
        if (livePid(pid)) return false;
        await unlink(path).catch(() => undefined);
        continue;
      }
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(path, FILE_MODE).catch(() => undefined);
      return true;
    }
    return false;
  }

  private async releaseAllocLock(id: number): Promise<void> {
    await unlink(this.allocLockPath(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

interface InspectedSlot {
  id: number;
  meta?: SlotMeta;
  attached: boolean;
}

export function locatorNotice(id: number, extraNotice?: string): string {
  const lines = [`Nvimotator ${id}`];
  if (extraNotice) lines.push(extraNotice);
  lines.push(`nvim -c 'NvimotatorAttach ${id}'`);
  return lines.join("\n");
}
