import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { MessageSnapshot } from "./assistant-message.ts";
import { captureFileSnapshot, resolveAnnotateFilePath } from "./file-snapshot.ts";
import { FileStore, FileStoreError, locatorNotice, type ExportResult } from "./file-store.ts";

const DEFAULT_VERSION = "0.4.0";

export class CliExitError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliExitError";
  }
}

export interface CliIo {
  stdout: { write(chunk: string): unknown; fd?: number };
  stderr: { write(chunk: string): unknown; fd?: number };
}

export interface FileCliHost {
  name: string;
  version: string;
  summary?: string;
  exportSnapshot: (options: { logPath?: string; cwd: string }) => MessageSnapshot | Promise<MessageSnapshot>;
  annotateSessionId?: () => string;
  store?: FileStore;
}

function usage(host: FileCliHost): string {
  const summary = host.summary ?? "snapshot the latest assistant message or a local file for Neovim";
  return [
    `${host.name} — ${summary}`,
    "",
    "Usage:",
    "  nvimotator export [--log <jsonl>]",
    "  nvimotator annotate <path>",
    "  nvimotator last",
    "  nvimotator import [id]",
    "  nvimotator cancel <id>",
    "  nvimotator --help",
    "",
    "export    Write the latest rendered assistant message into the file store and print the snapshot path.",
    "annotate  Write a local markdown/text/config/HTML/source file into the file store and print the snapshot path.",
    "last      Print the stable last-sent annotation path (not a rotating slot).",
    "import    Print a sent slot's annotation path and free that id. Without an id, imports the newest sent slot.",
    "cancel    Free a slot that is still waiting for Neovim Send.",
    "",
    "Stdout is one absolute path (the file the next actor needs). stderr may print a locator such as",
    "`Nvimotator 42` plus `nvim -c 'NvimotatorAttach 42'`. IDs recycle in 1–99 until Send, cancel, or TTL.",
  ].join("\n");
}

function fail(io: CliIo, message: string, code = 1): never {
  io.stderr.write(`${message}\n`);
  throw new CliExitError(message, code);
}

function printPath(io: CliIo, path: string): void {
  io.stdout.write(path.endsWith("\n") ? path : `${path}\n`);
}

function printLocator(io: CliIo, result: ExportResult, extra?: string): void {
  io.stderr.write(`${locatorNotice(result.id, extra)}\n`);
  printPath(io, result.snapshotPath);
}

export async function runFileStoreCli(argv: string[], io: CliIo, host: FileCliHost): Promise<void> {
  try {
    await runInner(argv, io, host);
  } catch (error) {
    if (error instanceof CliExitError) throw error;
    fail(io, error instanceof Error ? error.message : String(error));
  }
}

async function runInner(argv: string[], io: CliIo, host: FileCliHost): Promise<void> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    io.stdout.write(`${usage(host)}\n`);
    return;
  }
  if (args[0] === "-v" || args[0] === "--version" || args[0] === "version") {
    io.stdout.write(`${host.version || DEFAULT_VERSION}\n`);
    return;
  }

  const store = host.store ?? FileStore.fromEnv();

  if (args[0] === "export") {
    let logPath: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === "--log") {
        const next = args[index + 1];
        if (!next || next.startsWith("-")) fail(io, "Usage: nvimotator export [--log <jsonl>]");
        logPath = next;
        index += 1;
        continue;
      }
      fail(io, `Unknown argument: ${args[index]}`);
    }
    const snapshot = await host.exportSnapshot({ logPath, cwd: process.cwd() });
    const result = await store.exportSnapshot(snapshot);
    printLocator(io, result);
    return;
  }

  if (args[0] === "annotate") {
    const pathArgs = args.slice(1);
    if (pathArgs.length === 0) fail(io, "Usage: nvimotator annotate <path>");
    const target = pathArgs.join(" ");
    const sessionId = host.annotateSessionId?.() || "nvimotator";
    const path = await resolveAnnotateFilePath(target, process.cwd());
    const snapshot = await captureFileSnapshot(path, sessionId);
    const result = await store.exportSnapshot(snapshot);
    printLocator(io, result, snapshot.filePath ? `File: ${snapshot.filePath}` : undefined);
    return;
  }

  if (args[0] === "last") {
    if (args.length > 1) fail(io, "Usage: nvimotator last");
    const result = await store.last();
    printPath(io, result.annotationPath);
    return;
  }

  if (args[0] === "import") {
    if (args.length > 2) fail(io, "Usage: nvimotator import [id]");
    let id: number | undefined;
    if (args[1]) {
      const parsed = Number.parseInt(args[1], 10);
      if (!/^[1-9]\d*$/.test(args[1]) || parsed < 1 || parsed > 99) {
        fail(io, "Usage: nvimotator import [id]");
      }
      id = parsed;
    }
    const result = await store.importSlot(id);
    printPath(io, result.annotationPath);
    return;
  }

  if (args[0] === "cancel") {
    if (args.length !== 2) fail(io, "Usage: nvimotator cancel <id>");
    const parsed = Number.parseInt(args[1]!, 10);
    if (!/^[1-9]\d*$/.test(args[1]!) || parsed < 1 || parsed > 99) fail(io, "Usage: nvimotator cancel <id>");
    await store.cancel(parsed);
    return;
  }

  fail(io, `Unknown command: ${args[0]}\n\n${usage(host)}`);
}

export function isMainModule(importMetaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

export { FileStore, FileStoreError };
