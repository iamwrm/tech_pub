import { randomInt } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_BRIDGE_ID, MAX_MANIFEST_BYTES, MAX_UNIX_SOCKET_PATH_BYTES, type BridgeManifest } from "./protocol.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface SocketIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface RegistryReservation {
  bridgeId: number;
  directory: string;
  lockPath: string;
}

function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent");
}

export function registryDirectory(): string {
  return process.env.PI_NVIMOTATOR_REGISTRY
    ? resolve(process.env.PI_NVIMOTATOR_REGISTRY)
    : join(agentDirectory(), "pi-nvimotator", "registry");
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Registry path is not a safe directory: ${path}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Registry directory is not owned by the current user: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Registry directory permissions must already be owner-only: ${path}`);
}

export async function ensureRegistryDirectory(): Promise<string> {
  const directory = registryDirectory();
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  await assertPrivateDirectory(directory);
  return directory;
}

export function bridgeSocketPath(directory: string, bridgeId: number): string {
  const path = join(directory, `${bridgeId}.sock`);
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Nvimotator Unix socket path is too long (${Buffer.byteLength(path)} bytes); set PI_NVIMOTATOR_REGISTRY to a shorter owner-only path.`,
    );
  }
  return path;
}

function assertOwnedSocket(stat: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error(`Nvimotator socket path is not a Unix socket: ${path}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Nvimotator socket is not owned by the current user: ${path}`);
  }
}

export async function prepareSocketPath(reservation: RegistryReservation): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("Nvimotator requires owner-only Unix-domain sockets and is not available on native Windows.");
  }
  const path = bridgeSocketPath(reservation.directory, reservation.bridgeId);
  try {
    const stat = await lstat(path);
    assertOwnedSocket(stat, path);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
}

export async function secureBoundSocket(path: string): Promise<SocketIdentity> {
  const before = await lstat(path);
  assertOwnedSocket(before, path);
  await chmod(path, FILE_MODE);
  const after = await lstat(path);
  assertOwnedSocket(after, path);
  if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Nvimotator socket identity changed during setup.");
  if ((after.mode & 0o077) !== 0) throw new Error(`Nvimotator socket permissions are not owner-only: ${path}`);
  return { path, dev: after.dev, ino: after.ino };
}

export async function removeSocket(path: string | undefined, identity?: SocketIdentity): Promise<void> {
  if (!path) return;
  try {
    const stat = await lstat(path);
    if (identity && (identity.path !== path || stat.dev !== identity.dev || stat.ino !== identity.ino)) return;
    assertOwnedSocket(stat, path);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function candidate(attempt: number): number {
  return attempt < 128 ? randomInt(1, 100) : randomInt(100, MAX_BRIDGE_ID + 1);
}

export async function reserveBridgeId(): Promise<RegistryReservation> {
  const directory = await ensureRegistryDirectory();
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const bridgeId = candidate(attempt);
    const lockPath = join(directory, `${bridgeId}.lock`);
    let handle;
    try {
      handle = await open(lockPath, "wx", FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    let writeError: unknown;
    try {
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      writeError = error;
    } finally {
      await handle.close();
    }
    if (writeError !== undefined) {
      await unlink(lockPath).catch(() => undefined);
      throw writeError;
    }
    const reservation = { bridgeId, directory, lockPath };
    try {
      await lstat(manifestPath(directory, bridgeId));
      await releaseReservation(reservation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reservation;
      await releaseReservation(reservation).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("Could not allocate a free Nvimotator bridge ID.");
}

export async function releaseReservation(reservation: RegistryReservation): Promise<void> {
  await unlink(reservation.lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function manifestPath(directory: string, bridgeId: number): string {
  return join(directory, `${bridgeId}.json`);
}

async function writePrivateTemp(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, FILE_MODE);
}

export async function publishManifest(reservation: RegistryReservation, manifest: BridgeManifest): Promise<string> {
  const target = manifestPath(reservation.directory, reservation.bridgeId);
  const temporary = join(reservation.directory, `.${reservation.bridgeId}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const contents = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES) throw new Error("Bridge manifest is too large.");
  try {
    await writePrivateTemp(temporary, contents);
    await link(temporary, target);
    await unlink(temporary);
    await releaseReservation(reservation);
    return target;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function updateManifest(path: string, expectedToken: string, manifest: BridgeManifest): Promise<void> {
  const current = JSON.parse(await readFile(path, "utf8")) as Partial<BridgeManifest>;
  if (current.token !== expectedToken || current.instanceId !== manifest.instanceId) throw new Error("Bridge manifest ownership changed.");
  const temporary = join(dirname(path), `.${manifest.bridgeId}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const contents = `${JSON.stringify(manifest)}\n`;
  try {
    await writePrivateTemp(temporary, contents);
    await rename(temporary, path);
    await chmod(path, FILE_MODE);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeManifest(path: string | undefined, identity: { token: string; instanceId: string }): Promise<void> {
  if (!path) return;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    const current = JSON.parse(await readFile(path, "utf8")) as Partial<BridgeManifest>;
    if (current.token !== identity.token || current.instanceId !== identity.instanceId) return;
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
