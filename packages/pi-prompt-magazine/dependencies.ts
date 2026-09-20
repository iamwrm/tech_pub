import type Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
export const INSTALL_LOCK = ".pi-magazine-install.lock";
export const INSTALL_ARGS = ["install", "--omit=dev", "--no-audit", "--no-fund", "--save=false"];
const INSTALL_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 8_192;

export interface DependencyOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Overrides for isolated tests/deployments. */
  packageDir?: string;
  autoInstall?: boolean;
  lockTimeoutMs?: number;
  install?: (cwd: string, signal?: AbortSignal) => Promise<void>;
}

/** Only absence of the requested package permits installation. Native ABI,
 * transitive dependency, and database failures must never trigger npm. */
export function databaseDependencyAvailable(packageDir: string): boolean {
  const require = createRequire(join(packageDir, "package.json"));
  try {
    require.resolve("better-sqlite3");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
        (error as Error).message.startsWith("Cannot find module 'better-sqlite3'")) return false;
    throw error;
  }
  const Constructor = require("better-sqlite3") as typeof Database;
  // Loading the JS entry alone does not load the native binary.
  const db = new Constructor(":memory:");
  db.close();
  return true;
}

function diagnostic(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
}

/** Captured, bounded child process; never inherit the TUI's stdio. On POSIX,
 * kill the whole install process group (including native build subprocesses). */
export async function runInstallProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let output = "";
    let stopped: string | undefined;
    let spawnError: Error | undefined;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
    });
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_LIMIT); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore", windowsHide: true,
        });
        killer.on("error", () => { child.kill("SIGKILL"); });
        killer.on("exit", (code) => { if (code !== 0) child.kill("SIGKILL"); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop("installation cancelled");
    const timer = setTimeout(() => stop(`installation timed out after ${timeoutMs} ms`), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!stopped && !spawnError && code === 0) return resolve();
      const reason = stopped ?? spawnError?.message ?? `exit code ${code}`;
      const tail = diagnostic(output);
      reject(new Error(`npm dependency installation failed (${reason})${tail ? `:\n${tail}` : ""}`));
    });
  });
}

function installDependencies(cwd: string, signal?: AbortSignal): Promise<void> {
  // Windows npm is a .cmd shim. Only this fixed command is interpreted by cmd;
  // the package path is passed separately as cwd, never interpolated in a shell.
  return process.platform === "win32"
    ? runInstallProcess(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${INSTALL_ARGS.join(" ")}`], cwd, signal)
    : runInstallProcess("npm", INSTALL_ARGS, cwd, signal);
}

export async function ensureDatabaseDependency(options: DependencyOptions = {}): Promise<void> {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const lockPath = join(packageDir, INSTALL_LOCK);
  const manual = `Run npm install in ${packageDir}, then /reload. Native builds may need Python and a C++ toolchain.`;
  const signal = options.signal;
  let ownsLock = false;
  try {
    signal?.throwIfAborted();
    // Do not load a partially installed package while another Pi owns the lock.
    if (!existsSync(lockPath) && databaseDependencyAvailable(packageDir)) return;
    if (!(options.autoInstall ?? process.env.PI_PROMPT_MAGAZINE_AUTO_INSTALL !== "0")) {
      throw new Error("Automatic dependency installation is disabled (PI_PROMPT_MAGAZINE_AUTO_INSTALL=0).");
    }
    options.onProgress?.("Installing magazine dependencies (or waiting for another Pi installation)…");
    const deadline = Date.now() + (options.lockTimeoutMs ?? INSTALL_TIMEOUT_MS + 5_000);
    for (;;) {
      signal?.throwIfAborted();
      try {
        await mkdir(lockPath);
        ownsLock = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${lockPath}. If an earlier Pi crashed, verify no npm installation is running before removing this lock directory.`);
        }
        await delay(100, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    if (!databaseDependencyAvailable(packageDir)) {
      await (options.install ?? installDependencies)(packageDir, signal);
      signal?.throwIfAborted();
      if (!databaseDependencyAvailable(packageDir)) throw new Error("npm finished but better-sqlite3 is still missing");
    }
    options.onProgress?.("Magazine dependencies ready.");
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`${diagnostic(error instanceof Error ? error.message : String(error))}\n${manual}`);
  } finally {
    // Never steal a stale lock: a crashed parent's npm child might still run.
    if (ownsLock) await rmdir(lockPath);
  }
}
