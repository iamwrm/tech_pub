/**
 * Claude Code session discovery and last-rendered-message extraction.
 *
 * Discovery tiers follow Plannotator's Claude Code resolver (most precise
 * first): CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID, ancestor-PID metadata
 * under ~/.claude/sessions/<pid>.json, cwd-scan of that metadata, project
 * slug mtime, then an ancestor-directory walk. Transcript parsing walks
 * uuid/parentUuid so /rewind orphans are skipped.
 *
 * Claude-only. Droid/Codex/Pi sessionManager paths are out of scope.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export interface ClaudeSessionEntry {
  type: string;
  id?: string;
  uuid?: string;
  parentUuid?: string | null;
  visibility?: string;
  timestamp?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  message?: {
    id?: string;
    role?: unknown;
    visibility?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ClaudeMessage {
  messageId: string;
  text: string;
  lineNumbers: number[];
  timestamp?: string;
  sessionId: string;
}

export interface SessionMetadata {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

export interface DiscoveryPaths {
  configDir?: string;
  sessionsDir?: string;
  projectsDir?: string;
  cwd?: string;
  startPid?: number;
  getParentPid?: (pid: number) => number | null;
  maxHops?: number;
  sessionId?: string;
}

const SYSTEM_USER_PREFIXES = [
  "<local-command-",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<system-reminder>",
  "<system-notification>",
];

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function defaultSessionsDir(configDir = claudeConfigDir()): string {
  return join(configDir, "sessions");
}

export function defaultProjectsDir(configDir = claudeConfigDir()): string {
  return join(configDir, "projects");
}

export function normalizeCwdForCompare(cwd: string): string {
  if (process.platform === "win32") {
    return cwd.replace(/\//g, "\\").toLowerCase();
  }
  return cwd;
}

export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function envSessionId(): string | undefined {
  const raw = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function parseProcessTablePs(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[0]!, 10);
    const ppid = Number.parseInt(parts[1]!, 10);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) table.set(pid, ppid);
  }
  return table;
}

function snapshotProcessTable(): Map<number, number> {
  try {
    const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
    if (result.status !== 0) return new Map();
    return parseProcessTablePs(result.stdout);
  } catch {
    return new Map();
  }
}

export function createDefaultGetParentPid(): (pid: number) => number | null {
  let table: Map<number, number> | null = null;
  return (pid: number) => {
    if (table === null) table = snapshotProcessTable();
    const ppid = table.get(pid);
    return ppid && ppid > 0 ? ppid : null;
  };
}

export function getAncestorPids(
  startPid: number,
  maxHops: number,
  getParent: (pid: number) => number | null,
): number[] {
  if (!startPid || startPid <= 1) return [];
  const chain: number[] = [];
  const seen = new Set<number>();
  let pid: number | null = startPid;
  while (chain.length < maxHops && pid !== null && pid > 1 && !seen.has(pid)) {
    chain.push(pid);
    seen.add(pid);
    pid = getParent(pid);
  }
  return chain;
}

export function findClaudeSessions(projectDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl") && !name.startsWith("agent-"));
  } catch {
    return [];
  }
  const withMtime: { path: string; mtime: number }[] = [];
  for (const name of files) {
    const full = join(projectDir, name);
    try {
      withMtime.push({ path: full, mtime: statSync(full).mtimeMs });
    } catch {
      /* disappeared between readdir and stat */
    }
  }
  return withMtime.sort((left, right) => right.mtime - left.mtime).map((entry) => entry.path);
}

export function findClaudeSessionsForCwd(cwd: string, projectsDir: string): string[] {
  const slug = projectSlugFromCwd(cwd);
  const exact = findClaudeSessions(join(projectsDir, slug));
  if (exact.length > 0) return exact;
  const slugLower = slug.toLowerCase();
  try {
    for (const dir of readdirSync(projectsDir)) {
      if (dir.toLowerCase() === slugLower) {
        const logs = findClaudeSessions(join(projectsDir, dir));
        if (logs.length > 0) return logs;
      }
    }
  } catch {
    /* projects dir missing */
  }
  return [];
}

export function findClaudeSessionsByAncestorWalk(cwd: string, projectsDir: string): string[] {
  let dir = dirname(cwd);
  if (dir === cwd) return [];
  while (true) {
    const logs = findClaudeSessionsForCwd(dir, projectsDir);
    if (logs.length > 0) return logs;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

export function findClaudeSessionById(sessionId: string, projectsDir: string, cwd?: string): string | null {
  if (!sessionId) return null;
  const name = `${sessionId}.jsonl`;
  if (cwd) {
    const preferred = findClaudeSessionsForCwd(cwd, projectsDir).find((path) => basename(path) === name);
    if (preferred) return preferred;
  }
  try {
    for (const dir of readdirSync(projectsDir)) {
      const full = join(projectsDir, dir, name);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readSessionMetadata(pid: number, sessionsDir: string): SessionMetadata | null {
  try {
    return JSON.parse(readFileSync(join(sessionsDir, `${pid}.json`), "utf8")) as SessionMetadata;
  } catch {
    return null;
  }
}

export function isSessionRegistered(sessionId: string, sessionsDir: string): boolean {
  try {
    for (const name of readdirSync(sessionsDir).filter((file) => file.endsWith(".json"))) {
      try {
        const meta = JSON.parse(readFileSync(join(sessionsDir, name), "utf8")) as SessionMetadata;
        if (meta?.sessionId === sessionId) return true;
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function resolveClaudeSessionByAncestorPids(opts: DiscoveryPaths = {}): string | null {
  const startPid = opts.startPid ?? process.ppid;
  if (!startPid) return null;
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir(opts.configDir);
  const projectsDir = opts.projectsDir ?? defaultProjectsDir(opts.configDir);
  const getParent = opts.getParentPid ?? createDefaultGetParentPid();
  const maxHops = opts.maxHops ?? 8;
  for (const pid of getAncestorPids(startPid, maxHops, getParent)) {
    const meta = readSessionMetadata(pid, sessionsDir);
    if (!meta?.sessionId || !meta?.cwd) continue;
    const candidates = findClaudeSessionsForCwd(meta.cwd, projectsDir);
    const match = candidates.find((path) => basename(path) === `${meta.sessionId}.jsonl` || path.includes(meta.sessionId));
    if (!match) continue;
    if (candidates[0] && candidates[0] !== match) {
      const newestSessionId = basename(candidates[0], ".jsonl");
      if (!isSessionRegistered(newestSessionId, sessionsDir)) return candidates[0];
    }
    return match;
  }
  return null;
}

export function resolveClaudeSessionByCwdScan(opts: DiscoveryPaths = {}): string | null {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsDir = opts.sessionsDir ?? defaultSessionsDir(opts.configDir);
  const projectsDir = opts.projectsDir ?? defaultProjectsDir(opts.configDir);
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  const normalizedTarget = normalizeCwdForCompare(cwd);
  const candidates: SessionMetadata[] = [];
  for (const name of files) {
    try {
      const meta = JSON.parse(readFileSync(join(sessionsDir, name), "utf8")) as SessionMetadata;
      if (meta?.sessionId && meta?.cwd && normalizeCwdForCompare(meta.cwd) === normalizedTarget) {
        candidates.push(meta);
      }
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
  const logs = findClaudeSessionsForCwd(cwd, projectsDir);
  for (const meta of candidates) {
    const match = logs.find((path) => basename(path) === `${meta.sessionId}.jsonl` || path.includes(meta.sessionId));
    if (match) return match;
  }
  return null;
}

export function resolveClaudeSession(opts: DiscoveryPaths = {}): string | null {
  const cwd = opts.cwd ?? process.cwd();
  const projectsDir = opts.projectsDir ?? defaultProjectsDir(opts.configDir);
  const sessionId = opts.sessionId ?? envSessionId();
  if (sessionId) {
    const byId = findClaudeSessionById(sessionId, projectsDir, cwd);
    if (byId) return byId;
  }
  const ancestor = resolveClaudeSessionByAncestorPids(opts);
  if (ancestor) return ancestor;
  const cwdScan = resolveClaudeSessionByCwdScan({ ...opts, cwd });
  if (cwdScan) return cwdScan;
  const slug = findClaudeSessionsForCwd(cwd, projectsDir)[0];
  if (slug) return slug;
  return findClaudeSessionsByAncestorWalk(cwd, projectsDir)[0] ?? null;
}

export function parseClaudeSession(content: string): ClaudeSessionEntry[] {
  const entries: ClaudeSessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ClaudeSessionEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

function getEntryRole(entry: ClaudeSessionEntry): "user" | "assistant" | null {
  if (entry.type === "user" || entry.type === "assistant") return entry.type;
  const role = entry.message?.role;
  return role === "user" || role === "assistant" ? role : null;
}

function getVisibleTextBlocks(content: string | ContentBlock[] | undefined): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is ContentBlock & { text: string } => block.type === "text" && typeof block.text === "string" && Boolean(block.text.trim()))
    .map((block) => block.text);
}

function getEntryVisibility(entry: ClaudeSessionEntry): string | undefined {
  return entry.visibility ?? entry.message?.visibility;
}

function isHiddenTranscriptEntry(entry: ClaudeSessionEntry): boolean {
  const visibility = getEntryVisibility(entry)?.trim().toLowerCase();
  return visibility === "llm_only" || visibility === "assistant_only" || visibility === "hidden";
}

function getEntryMessageId(entry: ClaudeSessionEntry): string | undefined {
  return entry.message?.id ?? entry.id;
}

export function isHumanPrompt(entry: ClaudeSessionEntry): boolean {
  if (getEntryRole(entry) !== "user") return false;
  if (isHiddenTranscriptEntry(entry)) return false;
  const blocks = getVisibleTextBlocks(entry.message?.content);
  if (blocks.length === 0) return false;
  const content = blocks.join("\n");
  return !SYSTEM_USER_PREFIXES.some((prefix) => content.startsWith(prefix));
}

export function resolveActiveBranchIndices(entries: ClaudeSessionEntry[]): Set<number> | null {
  const indexByUuid = new Map<string, number>();
  let cursor = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const uuid = entries[index]?.uuid;
    if (typeof uuid === "string" && uuid) {
      indexByUuid.set(uuid, index);
      cursor = index;
    }
  }
  if (cursor === -1) return null;
  const branch = new Set<number>();
  for (;;) {
    if (branch.has(cursor)) return null;
    branch.add(cursor);
    const parentUuid = entries[cursor]?.parentUuid;
    if (parentUuid === null || parentUuid === undefined) return branch;
    if (typeof parentUuid !== "string") return null;
    const parentIndex = indexByUuid.get(parentUuid);
    if (parentIndex === undefined) return null;
    cursor = parentIndex;
  }
}

export function extractRecentClaudeMessages(
  entries: ClaudeSessionEntry[],
  beforeIndex: number,
  limit: number,
  opts: { branchIndices?: Set<number> | null } = {},
): ClaudeMessage[] {
  if (limit <= 0) return [];
  const { branchIndices } = opts;
  const buckets = new Map<string, { chunks: { texts: string[]; lineNum: number }[]; timestamp?: string; sessionId: string }>();
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (branchIndices && !branchIndices.has(index)) continue;
    if (entry.type === "progress" || entry.type === "system") continue;
    if (entry.type === "file-history-snapshot" || entry.type === "queue-operation") continue;
    if (getEntryRole(entry) !== "assistant") continue;
    if (isHiddenTranscriptEntry(entry)) continue;
    const texts = getVisibleTextBlocks(entry.message?.content);
    if (texts.length === 0) continue;
    const messageId = getEntryMessageId(entry);
    if (!messageId) continue;
    let bucket = buckets.get(messageId);
    if (!bucket) {
      if (buckets.size >= limit) continue;
      bucket = {
        chunks: [],
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
        sessionId: typeof entry.sessionId === "string" && entry.sessionId ? entry.sessionId : "",
      };
      buckets.set(messageId, bucket);
    }
    bucket.chunks.push({ texts, lineNum: index + 1 });
  }
  return Array.from(buckets, ([messageId, bucket]) => {
    const chrono = bucket.chunks.slice().reverse();
    return {
      messageId,
      text: chrono.flatMap((chunk) => chunk.texts).join("\n"),
      lineNumbers: chrono.map((chunk) => chunk.lineNum),
      timestamp: bucket.timestamp,
      sessionId: bucket.sessionId,
    };
  });
}

export function readTranscriptEntries(logPath: string): ClaudeSessionEntry[] {
  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return [];
  try {
    return parseClaudeSession(readFileSync(logPath, "utf8"));
  } catch {
    return [];
  }
}

export function getRecentClaudeMessages(
  logPath: string,
  limit: number,
  opts: { activeBranchOnly?: boolean } = {},
): ClaudeMessage[] {
  const entries = readTranscriptEntries(logPath);
  const branchIndices = opts.activeBranchOnly ? resolveActiveBranchIndices(entries) : null;
  const messages = extractRecentClaudeMessages(entries, entries.length, limit, { branchIndices });
  if (messages.length === 0 && branchIndices) {
    return extractRecentClaudeMessages(entries, entries.length, limit);
  }
  const fallbackSessionId = basename(logPath, ".jsonl");
  return messages.map((message) => ({
    ...message,
    sessionId: message.sessionId || fallbackSessionId,
  }));
}

export class LastMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LastMessageError";
  }
}

export function isNvimotatorUserTurn(entry: ClaudeSessionEntry): boolean {
  if (getEntryRole(entry) !== "user") return false;
  const blocks = getVisibleTextBlocks(entry.message?.content);
  const content = blocks.join("\n");
  return /nvimotator|\/nvim-last|\/nvim-annotate|\/nvim-import|\$nvim-last|\$nvim-annotate|\$nvim-import/i.test(content);
}

export function findActiveTurnBeforeIndex(entries: ClaudeSessionEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isNvimotatorUserTurn(entries[index]!)) return index;
  }
  let lastHuman = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (isHumanPrompt(entries[index]!)) lastHuman = index;
  }
  if (lastHuman === -1) return entries.length;
  for (let index = lastHuman + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (getEntryRole(entry) !== "assistant") continue;
    if (isHiddenTranscriptEntry(entry)) continue;
    if (getVisibleTextBlocks(entry.message?.content).length > 0 && getEntryMessageId(entry)) {
      return entries.length;
    }
  }
  return lastHuman;
}

export function captureLatestClaudeMessage(
  opts: DiscoveryPaths & { logPath?: string; beforeActiveTurn?: boolean } = {},
): ClaudeMessage {
  const logPath = opts.logPath ?? resolveClaudeSession(opts);
  if (!logPath) {
    throw new LastMessageError("No Claude Code session log was found for this working directory.");
  }
  const entries = readTranscriptEntries(logPath);
  const branchIndices = resolveActiveBranchIndices(entries);
  const beforeActiveTurn = opts.beforeActiveTurn !== false;
  const beforeIndex = beforeActiveTurn ? findActiveTurnBeforeIndex(entries) : entries.length;
  const pick = (index: number) => {
    const messages = extractRecentClaudeMessages(entries, index, 1, { branchIndices });
    if (messages.length === 0 && branchIndices) {
      return extractRecentClaudeMessages(entries, index, 1);
    }
    return messages;
  };
  let latest = pick(beforeIndex)[0];
  if (!latest?.text.trim() && beforeIndex !== entries.length) {
    latest = pick(entries.length)[0];
  }
  if (!latest?.text.trim()) {
    throw new LastMessageError("No rendered assistant message found in session logs.");
  }
  const fallbackSessionId = basename(logPath, ".jsonl");
  return { ...latest, sessionId: latest.sessionId || fallbackSessionId };
}
