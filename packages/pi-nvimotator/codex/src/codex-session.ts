/**
 * Codex rollout discovery and last-rendered-message extraction.
 *
 * Codex stores sessions at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl
 * (default ~/.codex when CODEX_HOME is unset). Detection prefers
 * CODEX_THREAD_ID (injected into spawned processes), then a session_meta cwd
 * match, then the newest rollout. Parsing walks response_item assistant
 * output_text blocks; function_call / user / developer lines are skipped.
 *
 * Codex-only. Plan-item / Stop-hook extraction is out of scope.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

const TURN_START_TYPES = new Set(["task_started", "turn_started"]);
const TURN_COMPLETE_TYPES = new Set(["task_complete", "turn_completed"]);
const THREAD_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface DiscoveryPaths {
  codexHome?: string;
  sessionsDir?: string;
  cwd?: string;
  threadId?: string;
  logPath?: string;
}

export interface CodexMessage {
  messageId: string;
  text: string;
  timestamp?: string;
  sessionId: string;
}

interface RolloutEntry {
  timestamp?: string;
  type: string;
  payload?: {
    type?: string;
    role?: string;
    id?: string;
    cwd?: unknown;
    turn_id?: string;
    content?: { type: string; text?: string }[];
    [key: string]: unknown;
  };
}

interface RolloutFile {
  path: string;
  mtime: number;
}

export function codexHome(override?: string): string {
  return override || process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function defaultSessionsDir(home = codexHome()): string {
  return join(home, "sessions");
}

export function envThreadId(): string | undefined {
  const raw = process.env.CODEX_THREAD_ID?.trim();
  return raw || undefined;
}

export function threadIdFromRolloutPath(rolloutPath: string): string {
  const match = THREAD_IN_NAME.exec(basename(rolloutPath));
  return match?.[1] ?? basename(rolloutPath, ".jsonl");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDayDirs(sessionsDir: string): string[] {
  const days: string[] = [];
  let years: string[];
  try {
    years = readdirSync(sessionsDir).sort().reverse();
  } catch {
    return [];
  }
  for (const year of years) {
    const yearDir = join(sessionsDir, year);
    if (!isDir(yearDir)) continue;
    for (const month of readdirSync(yearDir).sort().reverse()) {
      const monthDir = join(yearDir, month);
      if (!isDir(monthDir)) continue;
      for (const day of readdirSync(monthDir).sort().reverse()) {
        const dayDir = join(monthDir, day);
        if (isDir(dayDir)) days.push(dayDir);
      }
    }
  }
  return days;
}

export function listCodexRollouts(sessionsDir: string): RolloutFile[] {
  const files: RolloutFile[] = [];
  for (const dayDir of listDayDirs(sessionsDir)) {
    let names: string[];
    try {
      names = readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl") || !name.startsWith("rollout-")) continue;
      const full = join(dayDir, name);
      try {
        const stat = statSync(full);
        if (stat.isFile()) files.push({ path: full, mtime: stat.mtimeMs });
      } catch {
        /* disappeared between readdir and stat */
      }
    }
  }
  return files.sort((left, right) => right.mtime - left.mtime);
}

export function findCodexRolloutByThreadId(threadId: string, sessionsDir = defaultSessionsDir()): string | null {
  if (!threadId) return null;
  for (const file of listCodexRollouts(sessionsDir)) {
    if (basename(file.path).includes(threadId)) return file.path;
  }
  return null;
}

function readSessionMetaCwd(rolloutPath: string): string | undefined {
  let stat;
  try {
    stat = statSync(rolloutPath);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return undefined;
  let content: string;
  try {
    content = readFileSync(rolloutPath, "utf8");
  } catch {
    return undefined;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as RolloutEntry;
      if (entry.type === "session_meta" && typeof entry.payload?.cwd === "string" && entry.payload.cwd) {
        return entry.payload.cwd;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function findCodexRolloutByCwd(cwd: string, sessionsDir = defaultSessionsDir()): string | null {
  if (!cwd) return null;
  for (const file of listCodexRollouts(sessionsDir)) {
    if (readSessionMetaCwd(file.path) === cwd) return file.path;
  }
  return null;
}

export function findLatestCodexRollout(sessionsDir = defaultSessionsDir()): string | null {
  return listCodexRollouts(sessionsDir)[0]?.path ?? null;
}

export function resolveCodexRollout(opts: DiscoveryPaths = {}): string | null {
  if (opts.logPath) return opts.logPath;
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir(opts.codexHome);
  const threadId = opts.threadId ?? envThreadId();
  if (threadId) {
    const byThread = findCodexRolloutByThreadId(threadId, sessionsDir);
    if (byThread) return byThread;
  }
  const cwd = opts.cwd ?? process.cwd();
  const byCwd = findCodexRolloutByCwd(cwd, sessionsDir);
  if (byCwd) return byCwd;
  return findLatestCodexRollout(sessionsDir);
}

function parseRolloutEntries(rolloutPath: string): RolloutEntry[] {
  let stat;
  try {
    stat = statSync(rolloutPath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return [];
  let content: string;
  try {
    content = readFileSync(rolloutPath, "utf8");
  } catch {
    return [];
  }
  if (!content.trim()) return [];
  const entries: RolloutEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RolloutEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

function getMessageText(entry: RolloutEntry, allowedContentTypes: readonly string[]): string | null {
  if (entry.type !== "response_item") return null;
  if (entry.payload?.type !== "message") return null;
  const contentBlocks = entry.payload?.content;
  if (!Array.isArray(contentBlocks)) return null;
  const textParts = contentBlocks
    .filter((block) => allowedContentTypes.includes(block.type))
    .map((block) => (typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean);
  return textParts.length === 0 ? null : textParts.join("\n");
}

function findLastIndex(entries: RolloutEntry[], predicate: (entry: RolloutEntry) => boolean): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index]!)) return index;
  }
  return -1;
}

function findActiveTurnStartIndex(entries: RolloutEntry[]): number {
  const latestTurnStart = findLastIndex(
    entries,
    (entry) => entry.type === "event_msg" && TURN_START_TYPES.has(entry.payload?.type || ""),
  );
  if (latestTurnStart === -1) return -1;
  const latestTurnComplete = findLastIndex(
    entries,
    (entry) => entry.type === "event_msg" && TURN_COMPLETE_TYPES.has(entry.payload?.type || ""),
  );
  return latestTurnStart > latestTurnComplete ? latestTurnStart : -1;
}

export interface GetLastCodexMessageOptions {
  beforeActiveTurn?: boolean;
}

function collectAssistantMessages(
  entries: RolloutEntry[],
  endIndex: number,
  sessionId: string,
): CodexMessage[] {
  const messages: CodexMessage[] = [];
  for (let index = endIndex; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.payload?.role !== "assistant") continue;
    const text = getMessageText(entry, ["output_text"]);
    if (!text) continue;
    messages.push({
      messageId: `codex-msg-${index}`,
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      sessionId,
    });
  }
  return messages;
}

export function getRecentCodexMessages(
  rolloutPath: string,
  limit: number,
  options: GetLastCodexMessageOptions = {},
): CodexMessage[] {
  if (limit <= 0) return [];
  const entries = parseRolloutEntries(rolloutPath);
  const sessionId = threadIdFromRolloutPath(rolloutPath);
  const activeTurnStart = options.beforeActiveTurn ? findActiveTurnStartIndex(entries) : -1;
  const endIndex = activeTurnStart === -1 ? entries.length - 1 : activeTurnStart - 1;
  return collectAssistantMessages(entries, endIndex, sessionId).slice(0, limit);
}

export function getLastCodexMessage(
  rolloutPath: string,
  options: GetLastCodexMessageOptions = {},
): CodexMessage | null {
  return getRecentCodexMessages(rolloutPath, 1, options)[0] ?? null;
}

export class LastMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastMessageError";
  }
}

export function captureLatestCodexMessage(opts: DiscoveryPaths = {}): CodexMessage {
  const logPath = resolveCodexRollout(opts);
  if (!logPath) {
    throw new LastMessageError("No Codex rollout was found. Set CODEX_HOME or pass --log.");
  }
  const latest = getLastCodexMessage(logPath, { beforeActiveTurn: true })
    ?? getLastCodexMessage(logPath);
  if (!latest?.text.trim()) {
    throw new LastMessageError("No rendered assistant message found in Codex rollouts.");
  }
  return latest;
}
