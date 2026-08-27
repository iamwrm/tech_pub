import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { SnapshotError, type MessageSnapshot } from "./assistant-message.ts";

export const MAX_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_SNAPSHOT_LINES = 100_000;

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".mdc",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".jsonc",
  ".json5",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".html",
  ".htm",
]);

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
  ".cs", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".vue", ".svelte", ".astro",
  ".py", ".pyi", ".rb", ".php", ".swift", ".m", ".mm",
  ".lua", ".vim", ".sql", ".pl", ".pm", ".r", ".jl",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".css", ".scss", ".sass", ".less",
  ".graphql", ".gql", ".proto",
  ".ex", ".exs", ".erl", ".hrl", ".clj", ".cljs",
  ".hs", ".ml", ".mli", ".fs", ".fsx",
  ".nim", ".zig", ".dart",
  ".tf", ".nix",
]);

const ENV_EXAMPLE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore"]);
const SECRET_KEY_BASENAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);

export type AnnotateFileClass = "document" | "source" | "secret" | "unsupported";

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0) return "";
  return name.slice(index).toLowerCase();
}

export function parseAnnotatePathArg(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const start = trimmed[0];
    const end = trimmed[trimmed.length - 1];
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function isRemoteAnnotateTarget(path: string): boolean {
  return /^(https?:\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(path.trim());
}

export function classifyAnnotateFileName(name: string): AnnotateFileClass {
  const base = basename(name);
  const lower = base.toLowerCase();
  if (lower === ".env" || SECRET_KEY_BASENAMES.has(lower) || SECRET_KEY_EXTENSIONS.has(extensionOf(lower))) {
    return "secret";
  }
  if (lower.startsWith(".env.")) {
    return ENV_EXAMPLE_NAMES.has(lower) ? "document" : "secret";
  }
  const extension = extensionOf(lower);
  if (DOCUMENT_EXTENSIONS.has(extension) || ENV_EXAMPLE_NAMES.has(lower)) return "document";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  return "unsupported";
}

function classifyPathPair(displayPath: string, resolvedPath: string): AnnotateFileClass {
  const displayClass = classifyAnnotateFileName(displayPath);
  const resolvedClass = classifyAnnotateFileName(resolvedPath);
  if (displayClass === "secret" || resolvedClass === "secret") return "secret";
  if (displayClass === "unsupported") return "unsupported";
  return displayClass;
}

function rejectionForClass(fileClass: AnnotateFileClass, path: string): SnapshotError | undefined {
  if (fileClass === "secret") {
    return new SnapshotError(`Refusing to annotate secrets: ${path}`);
  }
  if (fileClass === "unsupported") {
    return new SnapshotError(
      `Unsupported file type for /nvim-annotate: ${path}. Use a local markdown, text, config, HTML, or source file.`,
    );
  }
  return undefined;
}

async function fileIdentity(path: string): Promise<{ displayPath: string; resolvedPath: string; size: number }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SnapshotError(`Path does not exist: ${path}`);
    if (code === "EACCES") throw new SnapshotError(`Permission denied: ${path}`);
    throw new SnapshotError(`Could not stat ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isDirectory()) {
    throw new SnapshotError(`Expected a file, got a directory: ${path}`);
  }
  let resolvedPath = path;
  try {
    resolvedPath = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SnapshotError(`Path does not exist: ${path}`);
    if (code === "EACCES") throw new SnapshotError(`Permission denied: ${path}`);
    throw new SnapshotError(`Could not resolve ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const resolvedInfo = await stat(resolvedPath).catch(async () => info);
  if (!resolvedInfo.isFile()) {
    throw new SnapshotError(`Not a regular file: ${path}`);
  }
  return { displayPath: path, resolvedPath, size: resolvedInfo.size };
}

export async function listAnnotatableFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SnapshotError(`Path does not exist: ${directory}`);
    if (code === "EACCES") throw new SnapshotError(`Permission denied: ${directory}`);
    throw new SnapshotError(`Could not read directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size > MAX_FILE_SNAPSHOT_BYTES) continue;
      const resolved = await realpath(full);
      const fileClass = classifyPathPair(full, resolved);
      if (fileClass === "document" || fileClass === "source") files.push(full);
    } catch {
      continue;
    }
  }
  files.sort((left, right) => basename(left).localeCompare(basename(right)));
  return files;
}

export async function resolveAnnotateFilePath(
  rawArg: string,
  cwd: string,
  pickFile?: (files: readonly string[]) => Promise<string | undefined>,
): Promise<string> {
  const parsed = parseAnnotatePathArg(rawArg);
  if (!parsed) {
    throw new SnapshotError("Usage: /nvim-annotate <path>");
  }
  if (isRemoteAnnotateTarget(parsed)) {
    throw new SnapshotError("nvimotator annotates local files only; URL, Jina, and live-app targets are out of scope.");
  }
  const displayPath = resolve(cwd, parsed);
  let info;
  try {
    info = await stat(displayPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SnapshotError(`Path does not exist: ${displayPath}`);
    if (code === "EACCES") throw new SnapshotError(`Permission denied: ${displayPath}`);
    throw new SnapshotError(`Could not stat ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (info.isDirectory()) {
    const files = await listAnnotatableFiles(displayPath);
    if (files.length === 0) {
      throw new SnapshotError(`No annotatable files found in ${displayPath}.`);
    }
    if (files.length === 1) return files[0]!;
    if (!pickFile) {
      throw new SnapshotError(
        `Directory has ${files.length} annotatable files; pass one file path rather than the folder.`,
      );
    }
    const selected = await pickFile(files);
    if (!selected) throw new SnapshotError("No file was selected.");
    if (!files.includes(selected)) {
      throw new SnapshotError("Selected path is not one of the annotatable files in that folder.");
    }
    return selected;
  }
  const identity = await fileIdentity(displayPath);
  const fileClass = classifyPathPair(identity.displayPath, identity.resolvedPath);
  const rejected = rejectionForClass(fileClass, identity.displayPath);
  if (rejected) throw rejected;
  if (identity.size > MAX_FILE_SNAPSHOT_BYTES) {
    throw new SnapshotError(`File is larger than ${MAX_FILE_SNAPSHOT_BYTES} bytes: ${identity.displayPath}`);
  }
  return identity.displayPath;
}

export async function captureFileSnapshot(filePath: string, sessionId: string): Promise<MessageSnapshot> {
  const identity = await fileIdentity(filePath);
  const fileClass = classifyPathPair(identity.displayPath, identity.resolvedPath);
  const rejected = rejectionForClass(fileClass, identity.displayPath);
  if (rejected) throw rejected;
  if (identity.size > MAX_FILE_SNAPSHOT_BYTES) {
    throw new SnapshotError(`File is larger than ${MAX_FILE_SNAPSHOT_BYTES} bytes: ${identity.displayPath}`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(identity.resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SnapshotError(`Path does not exist: ${identity.displayPath}`);
    if (code === "EACCES") throw new SnapshotError(`Permission denied: ${identity.displayPath}`);
    throw new SnapshotError(`Could not read ${identity.displayPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length > MAX_FILE_SNAPSHOT_BYTES) {
    throw new SnapshotError(`File is larger than ${MAX_FILE_SNAPSHOT_BYTES} bytes: ${identity.displayPath}`);
  }
  if (bytes.includes(0)) {
    throw new SnapshotError(`File is binary and cannot be annotated: ${identity.displayPath}`);
  }
  let decoded: string;
  try {
    decoded = fatalDecoder.decode(bytes);
  } catch {
    throw new SnapshotError(`File is not valid UTF-8: ${identity.displayPath}`);
  }
  const text = decoded.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.length > MAX_FILE_SNAPSHOT_LINES) {
    throw new SnapshotError(`File has more than ${MAX_FILE_SNAPSHOT_LINES} lines: ${identity.displayPath}`);
  }
  const messageHash = createHash("sha256").update(text).digest("hex");
  const pathHash = createHash("sha256").update(identity.displayPath).digest("hex");
  const snapshotId = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update("file")
    .update("\0")
    .update(identity.displayPath)
    .update("\0")
    .update(messageHash)
    .digest("hex");
  return Object.freeze({
    kind: "file",
    sessionId,
    entryId: `file-${pathHash}`,
    snapshotId,
    messageHash,
    text,
    lines: Object.freeze(lines),
    filePath: identity.displayPath,
  });
}

function completionValue(cwd: string, absolutePath: string, directory: boolean): string {
  const relativePath = relative(cwd, absolutePath);
  const display = relativePath && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
    ? relativePath
    : absolutePath;
  if (!directory) return display;
  return display.endsWith(sep) ? display : `${display}/`;
}

export function completeAnnotatePath(prefix: string, cwd: string): Array<{ value: string; label: string }> {
  const parsed = parseAnnotatePathArg(prefix);
  if (isRemoteAnnotateTarget(parsed)) return [];
  const hasTrailingSep = parsed.endsWith("/") || parsed.endsWith(sep);
  const absolutePrefix = parsed === "" ? `${resolve(cwd)}${sep}` : resolve(cwd, parsed);
  const directory = hasTrailingSep || parsed === "" ? absolutePrefix : dirname(absolutePrefix);
  const namePrefix = hasTrailingSep || parsed === "" ? "" : basename(parsed);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: Array<{ value: string; label: string }> = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(namePrefix)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const value = completionValue(cwd, full, true);
      matches.push({ value, label: `${entry.name}/` });
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const fileClass = classifyAnnotateFileName(entry.name);
    if (fileClass !== "document" && fileClass !== "source") continue;
    try {
      if (statSync(full).size > MAX_FILE_SNAPSHOT_BYTES) continue;
    } catch {
      continue;
    }
    const value = completionValue(cwd, full, false);
    matches.push({ value, label: entry.name });
  }
  matches.sort((left, right) => left.label.localeCompare(right.label));
  return matches.slice(0, 32);
}
