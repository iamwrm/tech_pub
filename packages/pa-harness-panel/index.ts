/**
 * pa-harness-panel — Prime Agent extension for skimming the current continual
 * harness state (prompt/memory/skill/subagent entries + refinement history)
 * in an interactive TUI panel, rendered from the raw harness_state.json files.
 *
 * Commands:
 *   /harness [filter]   open the TUI panel (entries | refinements | raw JSON)
 *   /harness text       print a readable text report into the transcript
 *   /harness raw        print the merged raw JSON into the transcript
 *
 * Hooks:
 *   refine_complete     live-refresh an open panel when /refine lands
 *
 * Data model mirrors prime-agent's internal refinement semantics
 * (dist/core/refinement/refinement.js):
 *   - global store:  <agentDir>/harness/harness_state.json + refinements.jsonl
 *   - local store:   <agentDir>/session-artifacts/<sessionId>/harness/harness_state.json
 *   - merged view:   global overlaid with local; on id collision the local
 *                    entry is re-keyed `local:<id>` (mergeHarnessStates)
 *   - refinements:   full records from refinements.jsonl + the session's
 *                    `prime-agent.refinement` custom entries, de-duped by id
 *                    (session wins); the compact `refinements` array in
 *                    harness_state.json is the fallback source.
 *   - corrupt/missing state files degrade to an empty store, never throw.
 *
 * The extension is read-only: harness edits belong to /refine, which owns
 * serialization, rollback (harnessStatePath), and system-prompt rebuild.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  Component,
} from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types (schema-v1 harness state)
// ---------------------------------------------------------------------------

export const HARNESS_KINDS = ["prompt", "memory", "skill", "subagent"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export interface HarnessEntry {
  id: string;
  kind: HarnessKind;
  title?: string;
  content?: string;
  path?: string;
  scope: "local" | "global";
  reference?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: string;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

export interface HarnessState {
  schema: number;
  entries: Record<HarnessKind, Record<string, HarnessEntry>>;
  /** Compact refinement log persisted inside harness_state.json. */
  refinements: Array<{
    id: string;
    trigger?: string;
    changes?: string[];
    evidence?: string;
    outcome?: string;
    created_at?: string;
  }>;
}

/** Full refinement result record (refinements.jsonl / session custom entries). */
export interface RefinementRecord {
  id: string;
  scope: "local" | "global";
  created_at?: string;
  summary?: string;
  trigger?: string;
  rationale?: string;
  expectedOutcome?: string;
  evidence?: string;
  outcome?: string;
  changes?: string[];
  appliedEdits?: unknown[];
  harnessStatePath?: string;
  [key: string]: unknown;
}

export interface HarnessSources {
  agentDir: string;
  globalEntriesPath?: string;
  globalRefinementsPath?: string;
  localEntriesPath?: string;
  localArtifactDir?: string;
}

export interface HarnessData {
  merged: HarnessState;
  refinements: RefinementRecord[];
  sources: HarnessSources;
  /** `${path}:${mtimeMs}` joined — changes when any source file changes. */
  mtimeKey: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Reading + merging (mirrors refinement.js load/merge semantics)
// ---------------------------------------------------------------------------

/** Strip ANSI/OSC escape sequences (display sanitization for external text). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\))|[()][AB0])/g, "");
}

export function emptyHarnessState(): HarnessState {
  return {
    schema: 1,
    entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
    refinements: [],
  };
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeScope(value: unknown, fallback: "local" | "global"): "local" | "global" {
  return value === "global" || value === "local" ? value : fallback;
}

/** Parse + normalize a harness_state.json payload. Never throws. */
export function parseHarnessState(raw: string, scope: "local" | "global"): HarnessState {
  const state = emptyHarnessState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return state;
  }
  const root = asObjectRecord(parsed);
  if (!root) return state;
  state.schema = typeof root.schema === "number" ? root.schema : 1;
  const entries = asObjectRecord(root.entries);
  if (entries) {
    for (const kind of HARNESS_KINDS) {
      const records = asObjectRecord(entries[kind]);
      if (!records) continue;
      for (const [id, rawEntry] of Object.entries(records)) {
        const entry = asObjectRecord(rawEntry);
        if (!entry) continue;
        state.entries[kind][id] = {
          id,
          kind,
          title: typeof entry.title === "string" ? entry.title : undefined,
          content: typeof entry.content === "string" ? entry.content : undefined,
          path: typeof entry.path === "string" ? entry.path : undefined,
          scope: normalizeScope(entry.scope, scope),
          reference: asObjectRecord(entry.reference) ?? {},
          arguments: asObjectRecord(entry.arguments) ?? {},
          metadata: asObjectRecord(entry.metadata) ?? {},
          source: typeof entry.source === "string" ? entry.source : undefined,
          created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
          version: typeof entry.version === "number" ? entry.version : undefined,
        };
      }
    }
  }
  if (Array.isArray(root.refinements)) {
    for (const r of root.refinements) {
      const rec = asObjectRecord(r);
      if (!rec || typeof rec.id !== "string") continue;
      state.refinements.push({
        id: rec.id,
        trigger: typeof rec.trigger === "string" ? rec.trigger : undefined,
        changes: Array.isArray(rec.changes) ? rec.changes.filter((c): c is string => typeof c === "string") : undefined,
        evidence: typeof rec.evidence === "string" ? rec.evidence : undefined,
        outcome: typeof rec.outcome === "string" ? rec.outcome : undefined,
        created_at: typeof rec.created_at === "string" ? rec.created_at : undefined,
      });
    }
  }
  return state;
}

/** Read a harness_state.json; missing/unreadable → undefined. */
export function loadHarnessStateFile(filePath: string | undefined, scope: "local" | "global"): HarnessState | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    return parseHarnessState(readFileSync(filePath, "utf8"), scope);
  } catch {
    return undefined;
  }
}

/** Merge global + local exactly like refinement.js mergeHarnessStates. */
export function mergeHarnessStates(globalState: HarnessState | undefined, localState: HarnessState | undefined): HarnessState {
  const merged = emptyHarnessState();
  merged.schema = Math.max(globalState?.schema ?? 1, localState?.schema ?? 1);
  for (const kind of HARNESS_KINDS) {
    for (const [id, entry] of Object.entries(globalState?.entries[kind] ?? {})) {
      merged.entries[kind][id] = { ...JSON.parse(JSON.stringify(entry)), scope: normalizeScope(entry.scope, "global") };
    }
    for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
      const cloned = { ...JSON.parse(JSON.stringify(entry)), scope: normalizeScope(entry.scope, "local") };
      const mergedId = merged.entries[kind][id] ? `local:${id}` : id;
      merged.entries[kind][mergedId] = cloned;
    }
  }
  merged.refinements = [...(globalState?.refinements ?? []), ...(localState?.refinements ?? [])];
  return merged;
}

/** Parse a refinements.jsonl payload (one full result per line). Never throws. */
export function parseRefinementsJsonl(text: string, fallbackScope: "local" | "global"): RefinementRecord[] {
  const out: RefinementRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed?.id !== "string") continue;
      out.push({
        id: parsed.id,
        scope: normalizeScope(parsed.scope, fallbackScope),
        created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
        summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
        trigger: typeof parsed.trigger === "string" ? parsed.trigger : undefined,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
        expectedOutcome: typeof parsed.expectedOutcome === "string" ? parsed.expectedOutcome : undefined,
        evidence: typeof parsed.evidence === "string" ? parsed.evidence : undefined,
        outcome: typeof parsed.outcome === "string" ? parsed.outcome : undefined,
        changes: Array.isArray(parsed.changes) ? parsed.changes.filter((c): c is string => typeof c === "string") : undefined,
        appliedEdits: Array.isArray(parsed.appliedEdits) ? parsed.appliedEdits : undefined,
        harnessStatePath: typeof parsed.harnessStatePath === "string" ? parsed.harnessStatePath : undefined,
        ...parsed,
      });
    } catch {
      // Skip malformed lines so one bad append cannot break the panel.
    }
  }
  return out;
}

/**
 * Extract full refinement records from the current session's custom entries
 * (`prime-agent.refinement`), matching agent-session's appendCustomEntry data.
 */
export function sessionRefinementRecords(entries: readonly unknown[]): RefinementRecord[] {
  const out: RefinementRecord[] = [];
  for (const raw of entries) {
    const e = asObjectRecord(raw);
    if (!e || e.type !== "custom") continue;
    if (e.customType !== "prime-agent.refinement") continue;
    const data = asObjectRecord(e.data);
    if (!data || typeof data.id !== "string") continue;
    const rec: RefinementRecord = {
      id: data.id as string,
      scope: normalizeScope(data.scope, "local"),
      created_at: typeof data.created_at === "string" ? data.created_at : undefined,
      summary: typeof data.summary === "string" ? data.summary : undefined,
      trigger: typeof data.trigger === "string" ? data.trigger : undefined,
      rationale: typeof data.rationale === "string" ? data.rationale : undefined,
      expectedOutcome: typeof data.expectedOutcome === "string" ? data.expectedOutcome : undefined,
      evidence: typeof data.evidence === "string" ? data.evidence : undefined,
      outcome: typeof data.outcome === "string" ? data.outcome : undefined,
      changes: Array.isArray(data.changes) ? data.changes.filter((c): c is string => typeof c === "string") : undefined,
      appliedEdits: Array.isArray(data.appliedEdits) ? data.appliedEdits : undefined,
      harnessStatePath: typeof data.harnessStatePath === "string" ? data.harnessStatePath : undefined,
    };
    out.push(rec);
  }
  return out;
}

/**
 * Merge global + session refinement history, de-duplicating by id; session
 * entries win (mirrors refinement.js mergeRefinementHistory).
 */
export function mergeRefinementRecords(
  globalRecords: RefinementRecord[],
  sessionRecords: RefinementRecord[],
): RefinementRecord[] {
  const byId = new Map<string, RefinementRecord>();
  for (const rec of globalRecords) byId.set(rec.id, rec);
  for (const rec of sessionRecords) {
    const existing = byId.get(rec.id);
    byId.set(rec.id, rec.scope || !existing ? rec : { ...rec, scope: existing.scope });
  }
  return [...byId.values()];
}

/** Resolve the harness directories for the current session. */
export function harnessDirPaths(
  sessionManager: { getSessionDir(): string; getSessionId(): string; getSessionArtifactDir?(): string | undefined },
  agentDir: string = getAgentDir(),
): HarnessSources {
  const globalDir = join(agentDir, "harness");
  const sm = sessionManager as {
    getSessionArtifactDir?: () => string | undefined;
  };
  const artifactDir =
    sm.getSessionArtifactDir?.() ??
    (sessionManager.getSessionDir()
      ? join(dirname(sessionManager.getSessionDir()), "session-artifacts", sessionManager.getSessionId())
      : undefined);
  const sources: HarnessSources = {
    agentDir,
    globalEntriesPath: join(globalDir, "harness_state.json"),
    globalRefinementsPath: join(globalDir, "refinements.jsonl"),
  };
  if (artifactDir) {
    sources.localArtifactDir = artifactDir;
    sources.localEntriesPath = join(artifactDir, "harness", "harness_state.json");
  }
  return sources;
}

function mtimeOf(filePath: string | undefined): number | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

export interface CollectHarnessCtx {
  sessionManager: {
    getSessionDir(): string;
    getSessionId(): string;
    getSessionName?(): string | undefined;
    getSessionArtifactDir?(): string | undefined;
    getEntries?(): readonly unknown[];
  };
  cwd?: string;
}

/** Collect + merge the full harness picture for the current session. */
export function collectHarnessData(ctx: CollectHarnessCtx, agentDir: string = getAgentDir()): HarnessData {
  const sources = harnessDirPaths(ctx.sessionManager, agentDir);

  const globalState = loadHarnessStateFile(sources.globalEntriesPath, "global");
  const localState = loadHarnessStateFile(sources.localEntriesPath, "local");
  const merged = mergeHarnessStates(globalState, localState);

  const globalRecords = sources.globalRefinementsPath && existsSync(sources.globalRefinementsPath)
    ? parseRefinementsJsonl(readFileSync(sources.globalRefinementsPath, "utf8"), "global")
    : [];
  const sessionRecords = ctx.sessionManager.getEntries
    ? sessionRefinementRecords(ctx.sessionManager.getEntries())
    : [];

  let refinements = mergeRefinementRecords(globalRecords, sessionRecords);
  if (refinements.length === 0 && merged.refinements.length > 0) {
    // Fallback: compact log persisted inside harness_state.json.
    refinements = merged.refinements.map((r) => ({
      id: r.id,
      scope: "local" as const,
      created_at: r.created_at,
      trigger: r.trigger,
      evidence: r.evidence,
      outcome: r.outcome,
      changes: r.changes,
      summary: r.trigger,
    }));
  }
  refinements.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

  const files = [
    sources.globalEntriesPath,
    sources.globalRefinementsPath,
    sources.localEntriesPath,
  ];
  const mtimeKey = files
    .map((f) => `${f}:${mtimeOf(f) ?? "-"}`)
    .join("|");

  return {
    merged,
    refinements,
    sources,
    mtimeKey,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: ctx.sessionManager.getSessionName?.() ?? undefined,
    cwd: ctx.cwd,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (non-TUI output)
// ---------------------------------------------------------------------------

function kindCounts(state: HarnessState): Record<HarnessKind, { total: number; local: number; global: number }> {
  const counts = {} as Record<HarnessKind, { total: number; local: number; global: number }>;
  for (const kind of HARNESS_KINDS) {
    const list = Object.values(state.entries[kind]);
    const local = list.filter((e) => e.scope === "local").length;
    counts[kind] = { total: list.length, local, global: list.length - local };
  }
  return counts;
}

function entrySummary(entry: HarnessEntry): string {
  const text = stripAnsi(entry.content ?? "").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function changeLabel(change: unknown): string {
  return typeof change === "string" ? change : String(change ?? "");
}

/** Readable text report for non-TUI modes (/harness text). */
export function formatTextReport(data: HarnessData): string {
  const { merged, refinements } = data;
  const counts = kindCounts(merged);
  const lines: string[] = [];
  lines.push("═ continual harness state ═");
  if (data.sessionName || data.sessionId) {
    lines.push(`session: ${data.sessionName ? `${data.sessionName} ` : ""}${data.sessionId ?? ""}`);
  }
  lines.push(`global: ${data.sources.globalEntriesPath ?? "-"}`);
  if (data.sources.localEntriesPath) lines.push(`local:  ${data.sources.localEntriesPath}`);
  lines.push(
    `entries: ${HARNESS_KINDS.map((k) => {
      const c = counts[k];
      const parts = [];
      if (c.local > 0) parts.push(`${c.local} local`);
      if (c.global > 0) parts.push(`${c.global} global`);
      return `${k} ${c.total}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    }).join(" · ")}`,
  );
  lines.push(`refinements: ${refinements.length} (global+session, newest first)`);
  lines.push("");
  for (const kind of HARNESS_KINDS) {
    const list = Object.values(merged.entries[kind]).sort(compareEntries);
    if (list.length === 0) continue;
    lines.push(`── ${kind} ──`);
    for (const entry of list) {
      const scope = entry.scope === "local" ? "local" : "global";
      const version = entry.version !== undefined ? ` v${entry.version}` : "";
      const path = entry.path ? ` · ${entry.path}` : "";
      lines.push(`[${scope}] ${entry.id}${version}${path} ${entry.title ?? entry.id}`);
      lines.push(`    ${entrySummary(entry)}`);
      if (kind === "skill" && entry.reference && Object.keys(entry.reference).length > 0) {
        lines.push(`    reference: ${JSON.stringify(entry.reference)}`);
      }
    }
    lines.push("");
  }
  if (refinements.length > 0) {
    lines.push(`── refinements (${refinements.length}) ──`);
    for (const rec of refinements) {
      lines.push(`${rec.id} · ${rec.scope} · ${rec.created_at ?? "?"}`);
      lines.push(`  ${rec.summary ?? rec.trigger ?? "(no summary)"}`);
      if (rec.changes && rec.changes.length > 0) {
        lines.push(`  ${rec.changes.map(changeLabel).join(" · ")}`);
      }
    }
  }
  return lines.join("\n");
}

/** Pretty-printed merged raw JSON (/harness raw). */
export function formatRawJson(data: HarnessData): string {
  return JSON.stringify({ ...data.merged, refinements: data.refinements }, null, 2);
}

// ---------------------------------------------------------------------------
// Palette (theme adapter; passthrough when no theme is available)
// ---------------------------------------------------------------------------

export interface PanelThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
}

export interface Palette {
  title(text: string): string;
  accent(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  good(text: string): string;
  warn(text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
  /** Raw JSON token coloring. */
  json(text: string): string;
}

const PASSTHROUGH = (text: string): string => text;

export function createPalette(theme: PanelThemeLike | undefined): Palette {
  if (!theme) {
    return {
      title: PASSTHROUGH, accent: PASSTHROUGH, muted: PASSTHROUGH, dim: PASSTHROUGH,
      good: PASSTHROUGH, warn: PASSTHROUGH, bold: PASSTHROUGH, inverse: PASSTHROUGH,
      json: PASSTHROUGH,
    };
  }
  return {
    title: (t) => theme.bold(t),
    accent: (t) => theme.fg("accent", t),
    muted: (t) => theme.fg("muted", t),
    dim: (t) => theme.fg("dim", t),
    good: (t) => theme.fg("success", t),
    warn: (t) => theme.fg("warning", t),
    bold: (t) => theme.bold(t),
    inverse: (t) => theme.inverse(t),
    json: (t) => theme.fg("mdCode", t),
  };
}

// ---------------------------------------------------------------------------
// Shared framing (overlay compositing: every interior line padded to width)
// ---------------------------------------------------------------------------

export function framePanel(title: string, inner: string[], width: number, palette: Palette): string[] {
  const W = Math.max(4, width - 2);
  const top = `┌─ ${palette.title(title)} ${"─".repeat(Math.max(1, W - visibleWidth(title) - 3))}┐`;
  const out: string[] = [top];
  for (const line of inner) {
    const plain = stripAnsi(line);
    const pad = Math.max(0, W - visibleWidth(plain));
    out.push(`│${line}${" ".repeat(pad)}│`);
  }
  const bottom = `└${"─".repeat(W)}┘`;
  out.push(bottom);
  // Width contract for the full frame including borders.
  return out.map((l) => {
    const w = visibleWidth(l);
    return w <= width ? l : truncateToWidth(l, width);
  });
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

export type HarnessView = "entries" | "refinements" | "raw";

export interface HarnessPanelOptions {
  data: HarnessData;
  palette: Palette;
  requestRender: () => void;
  onClose: () => void;
  /** Re-read data from disk; returns true when the data changed. */
  onRefresh?: () => boolean;
  initialFilter?: string;
  initialView?: HarnessView;
}

interface EntryRow {
  kind: "kind";
  header: string;
  total: number;
  local: number;
  global: number;
  label: string;
}
interface ItemRow {
  kind: "item";
  key: string;
  label: string;
  detail: string[];
}
type Row = EntryRow | ItemRow;

function compareEntries(a: HarnessEntry, b: HarnessEntry): number {
  return [a.path ?? "", a.title ?? "", a.id]
    .join("\0")
    .localeCompare([b.path ?? "", b.title ?? "", b.id].join("\0"));
}

function sanitize(text: string): string {
  return stripAnsi(text)
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function shortDate(iso: string | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function formatArgsTable(args: Record<string, unknown> | undefined): string[] {
  if (!args || Object.keys(args).length === 0) return ["  arguments: {}"];
  const lines = ["  arguments:"];
  for (const [name, spec] of Object.entries(args)) {
    const s = asObjectRecord(spec);
    if (!s) {
      lines.push(`    ${name}: ${JSON.stringify(spec)}`);
      continue;
    }
    const parts: string[] = [];
    if (typeof s.type === "string") parts.push(`type=${s.type}`);
    if (s.required === true) parts.push("required");
    if (s.required === false) parts.push("optional");
    if (typeof s.default !== "undefined") parts.push(`default=${JSON.stringify(s.default)}`);
    const desc = typeof s.description === "string" ? ` — ${s.description}` : "";
    lines.push(`    ${name}${parts.length ? ` (${parts.join(", ")})` : ""}${desc}`);
  }
  return lines;
}

function entryDetail(entry: HarnessEntry, mapKey?: string): string[] {
  const lines: string[] = [];
  lines.push(`id: ${entry.id}`);
  // The merged-store key carries the `local:` prefix when a session entry
  // collides with a global id; edits always use the bare id, the merged view
  // uses the map key.
  if (mapKey && mapKey !== entry.id) lines.push(`map key: ${mapKey}`);
  const meta: string[] = [`kind: ${entry.kind}`, `scope: ${entry.scope}`];
  if (entry.path) meta.push(`path: ${entry.path}`);
  if (entry.version !== undefined) meta.push(`v${entry.version}`);
  if (entry.source) meta.push(`source: ${entry.source}`);
  lines.push(meta.join("  ·  "));
  if (entry.created_at || entry.updated_at) {
    lines.push(`created: ${shortDate(entry.created_at)}  ·  updated: ${shortDate(entry.updated_at)}`);
  }
  if (entry.title) lines.push(`title: ${entry.title}`);
  const content = sanitize(entry.content ?? "");
  if (content) {
    lines.push("content:");
    lines.push(...wrapToWidth(content, 100));
  }
  if (entry.kind === "skill") {
    const ref = entry.reference ?? {};
    if (Object.keys(ref).length > 0) {
      lines.push(`reference: ${JSON.stringify(ref)}`);
    }
    lines.push(...formatArgsTable(entry.arguments));
  }
  return lines;
}

/** Word-wrap plain text to a max visible width (ANSI-free input). */
export function wrapToWidth(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (visibleWidth(raw) <= maxWidth) {
      out.push(raw);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const token of raw.split(/(\s+)/)) {
      if (token.length === 0) continue;
      const tw = visibleWidth(token);
      if (tw > maxWidth) {
        // Hard-break an unbreakable token (URL, long base64, ...).
        if (current) {
          out.push(current);
          current = "";
          currentWidth = 0;
        }
        let chunk = "";
        let chunkWidth = 0;
        for (const ch of token) {
          const cw = visibleWidth(ch);
          if (chunkWidth + cw > maxWidth) {
            out.push(chunk);
            chunk = "";
            chunkWidth = 0;
          }
          chunk += ch;
          chunkWidth += cw;
        }
        if (chunk) {
          current = chunk;
          currentWidth = chunkWidth;
        }
        continue;
      }
      // Add a single separating space before a word token only when the line
      // does not already end with whitespace; whitespace tokens are kept as-is
      // (which also preserves intentional duplicate spaces).
      const separator = current.length > 0 && !current.endsWith(" ") && !token.startsWith(" ");
      if (currentWidth + tw > maxWidth && currentWidth > 0) {
        out.push(current);
        current = token.trimStart();
        currentWidth = visibleWidth(current);
      } else {
        current += separator ? ` ${token}` : token;
        currentWidth = visibleWidth(current);
      }
    }
    if (current.trim().length > 0 || raw.trim().length === 0) out.push(current);
  }
  return out;
}

function refinementDetail(rec: RefinementRecord): string[] {
  const lines: string[] = [];
  lines.push(`id: ${rec.id}`);
  lines.push(`scope: ${rec.scope}  ·  created: ${shortDate(rec.created_at)}`);
  if (rec.summary) lines.push(`summary: ${rec.summary}`);
  if (rec.trigger) lines.push(`trigger: ${rec.trigger}`);
  if (rec.changes && rec.changes.length > 0) {
    lines.push(`changes: ${rec.changes.map(changeLabel).join("  ·  ")}`);
  }
  if (rec.rationale) {
    lines.push("rationale:");
    lines.push(...wrapToWidth(rec.rationale, 100));
  }
  if (rec.expectedOutcome) {
    lines.push("expected outcome:");
    lines.push(...wrapToWidth(rec.expectedOutcome, 100));
  }
  if (rec.evidence) {
    lines.push("evidence:");
    lines.push(...wrapToWidth(rec.evidence, 100));
  }
  if (rec.outcome) {
    lines.push("outcome:");
    lines.push(...wrapToWidth(rec.outcome, 100));
  }
  if (rec.appliedEdits && rec.appliedEdits.length > 0) {
    lines.push(`applied edits (${rec.appliedEdits.length}):`);
    for (const rawEdit of rec.appliedEdits) {
      const edit = asObjectRecord(rawEdit);
      if (!edit) {
        lines.push(`  ${JSON.stringify(rawEdit)}`);
        continue;
      }
      const action = typeof edit.action === "string" ? edit.action : "?";
      const kind = typeof edit.kind === "string" ? edit.kind : "?";
      const id = typeof edit.id === "string" ? edit.id : "?";
      const applied = edit.applied === false ? " (not applied)" : "";
      const reason = typeof edit.reason === "string" ? ` — ${edit.reason}` : "";
      lines.push(`  ${action} ${kind}:${id}${applied}${reason}`);
    }
  }
  if (rec.harnessStatePath) lines.push(`harnessStatePath: ${rec.harnessStatePath}`);
  return lines;
}

/** Minimal JSON token coloring for the raw view (display-only, never parsed). */
export function colorizeJson(text: string, palette: Palette): string {
  const token =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([\[\]{}:,])/g;
  let last = 0;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    out.push(text.slice(last, match.index));
    const [full, str, colon, num, lit, punct] = match;
    if (str !== undefined) {
      out.push(colon ? palette.accent(str) : palette.good(str));
      if (colon) out.push(palette.dim(colon));
    } else if (num !== undefined) {
      out.push(palette.warn(num));
    } else if (lit !== undefined) {
      out.push(palette.muted(lit));
    } else if (punct !== undefined) {
      out.push(palette.dim(punct));
    } else {
      out.push(full);
    }
    last = match.index + full.length;
  }
  out.push(text.slice(last));
  return out.join("");
}

export class HarnessPanel implements Component {
  readonly options: HarnessPanelOptions;
  private data: HarnessData;
  private view: HarnessView;
  private filter = "";
  private filterActive = false;
  private cursor = 0;
  private expanded = new Set<string>();
  private closed = false;
  disposed = false;

  constructor(options: HarnessPanelOptions) {
    this.options = options;
    this.data = options.data;
    this.view = options.initialView ?? "entries";
    this.filter = options.initialFilter ?? "";
    if (this.filter) this.filterActive = true;
  }

  invalidate(): void {
    // No cached render state to drop.
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Called by the host (refine_complete) to force a fresh read. */
  refreshNow(): boolean {
    if (this.disposed || this.closed) return false;
    try {
      const changed = this.options.onRefresh?.() ?? false;
      if (changed) this.invalidate();
      return changed;
    } catch {
      return false;
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disposed = true;
    this.options.onClose();
  }

  // -- rows ----------------------------------------------------------------

  private entriesRows(): Row[] {
    const rows: Row[] = [];
    for (const kind of HARNESS_KINDS) {
      const list = Object.values(this.data.merged.entries[kind]).sort(compareEntries);
      const filtered = this.filter
        ? list.filter((e) => this.entryMatchesFilter(e))
        : list;
      if (filtered.length === 0) continue;
      const local = filtered.filter((e) => e.scope === "local").length;
      rows.push({
        kind: "kind",
        header: kind,
        total: filtered.length,
        local,
        global: filtered.length - local,
        label: `${kind} · ${filtered.length}${local ? ` (${local} local)` : ""}`,
      });
      for (const entry of filtered) {
        rows.push({
          kind: "item",
          key: `entry:${kind}:${entry.id}`,
          label: this.entryLabel(entry),
          detail: entryDetail(entry),
        });
      }
    }
    return rows;
  }

  private entryMatchesFilter(entry: HarnessEntry): boolean {
    const needle = this.filter.toLowerCase();
    const haystack = [
      entry.id,
      entry.kind,
      entry.path ?? "",
      entry.title ?? "",
      entry.content ?? "",
    ].join("\n").toLowerCase();
    return haystack.includes(needle);
  }

  private entryLabel(entry: HarnessEntry): string {
    const scopeBadge = entry.scope === "local" ? "local" : "global";
    const version = entry.version !== undefined ? `v${entry.version} ` : "";
    const path = entry.path ? `${entry.path} ` : "";
    const title = entry.title ?? entry.id;
    const preview = sanitize(entry.content ?? "").replace(/\s+/g, " ").trim();
    return `${scopeBadge} ${version}${path}${title}${preview ? ` — ${preview.slice(0, 80)}` : ""}`;
  }

  private refinementRows(): Row[] {
    const rows: Row[] = [];
    const list = this.filter
      ? this.data.refinements.filter((r) =>
          [r.id, r.summary ?? "", r.trigger ?? "", (r.changes ?? []).join(" ")]
            .join("\n")
            .toLowerCase()
            .includes(this.filter.toLowerCase()))
      : this.data.refinements;
    if (list.length > 0) {
      rows.push({
        kind: "kind",
        header: "refinements",
        total: list.length,
        local: list.filter((r) => r.scope === "local").length,
        global: list.filter((r) => r.scope === "global").length,
        label: `refinements · ${list.length} (newest first)`,
      });
    }
    for (const rec of list) {
      rows.push({
        kind: "item",
        key: `refinement:${rec.id}`,
        label: `${rec.scope} ${shortDate(rec.created_at)} ${rec.id} — ${rec.summary ?? rec.trigger ?? "(no summary)"}`,
        detail: refinementDetail(rec),
      });
    }
    return rows;
  }

  private visibleRows(): Row[] {
    return this.view === "refinements" ? this.refinementRows() : this.entriesRows();
  }

  // -- input ---------------------------------------------------------------

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.filterActive) {
      if (matchesKey(data, Key.escape)) {
        this.filterActive = false;
        this.cursor = 0;
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.filterActive = false;
        this.cursor = 0;
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.filter = this.filter.slice(0, -1);
        this.cursor = 0;
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
        this.filter += data;
        this.cursor = 0;
        return;
      }
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      this.close();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveCursor(10);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveCursor(-10);
      return;
    }
    if (data === "g") {
      this.cursor = 0;
      return;
    }
    if (data === "G") {
      this.cursor = this.itemRows().length - 1;
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      this.toggleExpand();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.expanded.clear();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.cycleView();
      return;
    }
    if (data === "1") {
      this.setView("entries");
      return;
    }
    if (data === "2") {
      this.setView("refinements");
      return;
    }
    if (data === "3") {
      this.setView("raw");
      return;
    }
    if (data === "/") {
      this.filterActive = true;
      return;
    }
    if (data === "r") {
      this.refreshNow();
      this.options.requestRender();
    }
  }

  private itemRows(): ItemRow[] {
    return this.visibleRows().filter((r): r is ItemRow => r.kind === "item");
  }

  private moveCursor(delta: number): void {
    const items = this.itemRows();
    if (items.length === 0) return;
    this.cursor = Math.max(0, Math.min(items.length - 1, this.cursor + delta));
  }

  private toggleExpand(): void {
    const items = this.itemRows();
    const row = items[this.cursor];
    if (!row) return;
    if (this.expanded.has(row.key)) {
      this.expanded.delete(row.key);
    } else {
      this.expanded.add(row.key);
    }
  }

  private setView(view: HarnessView): void {
    this.view = view;
    this.cursor = 0;
  }

  private cycleView(): void {
    const order: HarnessView[] = ["entries", "refinements", "raw"];
    const next = order[(order.indexOf(this.view) + 1) % order.length];
    this.setView(next);
  }

  // -- render --------------------------------------------------------------

  render(width: number): string[] {
    const W = Math.max(12, width - 2);
    const inner: string[] = [];
    inner.push(this.headerLine(W));
    inner.push(this.statusLine(W));
    if (this.filterActive) inner.push(this.filterLine(W));
    inner.push(this.pathsLine(W));
    inner.push("");
    inner.push(...this.bodyLines(W));
    inner.push("");
    inner.push(this.footerLine(W));
    return framePanel(`HARNESS ${this.view}`, inner, width, this.options.palette);
  }

  private headerLine(W: number): string {
    const p = this.options.palette;
    const tabs: HarnessView[] = ["entries", "refinements", "raw"];
    const tabText = tabs
      .map((t, i) => (t === this.view ? p.inverse(` ${i + 1}:${t} `) : p.dim(` ${i + 1}:${t} `)))
      .join(" ");
    const label = this.data.sessionName
      ? `session: ${this.data.sessionName}`
      : this.data.sessionId ?? "no session";
    const right = p.dim(label);
    const sep = W - visibleWidth(tabText) - visibleWidth(right) - 2;
    return `${tabText}${" ".repeat(Math.max(1, sep))}${right}`;
  }

  private statusLine(W: number): string {
    const p = this.options.palette;
    const counts = kindCounts(this.data.merged);
    const parts = HARNESS_KINDS.map((k) => {
      const c = counts[k];
      return c.total === 0 ? p.dim(`${k} 0`) : `${k} ${c.total}${c.local ? p.good(`·${c.local}L`) : ""}${c.global ? p.muted(`·${c.global}G`) : ""}`;
    });
    const refs = `${this.data.refinements.length} refinements`;
    const right = p.muted(refs);
    const left = parts.join("  ");
    const sep = W - visibleWidth(left) - visibleWidth(right) - 2;
    return `${left}${" ".repeat(Math.max(1, sep))}${right}`;
  }

  private pathsLine(W: number): string {
    const p = this.options.palette;
    const local = this.data.sources.localEntriesPath
      ? truncateToWidth(`local: ${this.data.sources.localEntriesPath}`, Math.max(10, Math.floor(W / 2)))
      : p.dim("local: (no persisted session)");
    const globalPath = this.data.sources.globalEntriesPath
      ? truncateToWidth(`global: ${this.data.sources.globalEntriesPath}`, Math.max(10, W - visibleWidth(local) - 2))
      : "";
    return `${p.dim(local)}  ${p.dim(globalPath)}`;
  }

  private filterLine(W: number): string {
    const p = this.options.palette;
    return `${p.accent("filter:")} ${this.filter}${p.dim("▏")}`;
  }

  private bodyLines(W: number): string[] {
    const p = this.options.palette;
    if (this.view === "raw") return this.rawLines(W);
    const rows = this.visibleRows();
    if (rows.length === 0) {
      return [p.dim(this.filter ? `no matches for “${this.filter}”` : "empty — run /refine to create entries")];
    }
    const items = this.itemRows();
    if (this.cursor >= items.length) this.cursor = Math.max(0, items.length - 1);
    const lines: string[] = [];
    const MAX_BODY = 40;
    let rowIndex = 0;
    for (const row of rows) {
      if (lines.length >= MAX_BODY) break;
      if (row.kind === "kind") {
        lines.push(p.accent(`─ ${row.label} ─`));
        continue;
      }
      const itemIndex = items.indexOf(row);
      const selected = itemIndex === this.cursor;
      const collapsed = this.expanded.has(row.key);
      const label = truncateToWidth(row.label, W - 2);
      lines.push(selected ? p.inverse(` ${label} `) : ` ${label}`);
      if (collapsed) {
        for (const detailLine of row.detail) {
          if (lines.length >= MAX_BODY) break;
          for (const wrapped of wrapToWidth(detailLine, W - 6)) {
            if (lines.length >= MAX_BODY) break;
            lines.push(p.dim(`  │ ${wrapped}`));
          }
        }
      }
    }
    return lines;
  }

  private rawLines(W: number): string[] {
    const p = this.options.palette;
    const raw = JSON.stringify(
      { ...this.data.merged, refinements: this.data.refinements },
      null,
      2,
    );
    const colored = colorizeJson(raw, p);
    const lines: string[] = [];
    const MAX_BODY = 40;
    for (const line of colored.split("\n")) {
      if (lines.length >= MAX_BODY) break;
      lines.push(truncateToWidth(line, W - 2));
    }
    if (lines.length === 0) lines.push(p.dim("(empty state)"));
    return lines;
  }

  private footerLine(W: number): string {
    const p = this.options.palette;
    const hints =
      this.view === "raw"
        ? "↑↓/j/k scroll · 1/2/3 or Tab view · r refresh · q close"
        : "↑↓/j/k move · Enter expand · / filter · 1/2/3 or Tab view · r refresh · q close";
    return p.dim(hints);
  }
}

// ---------------------------------------------------------------------------
// Transcript renderer for /harness text|raw reports
// ---------------------------------------------------------------------------

export class HarnessReportRenderer implements Component {
  private text: string;
  private title: string;

  constructor(content: string, title = "harness") {
    this.text = content;
    this.title = title;
  }

  invalidate(): void {
    // static content
  }

  render(width: number): string[] {
    const palette = createPalette(undefined);
    const W = Math.max(12, width - 2);
    const inner: string[] = [];
    for (const line of this.text.split("\n")) {
      inner.push(truncateToWidth(line, W));
    }
    return framePanel(this.title, inner, width, palette);
  }
}


// ---------------------------------------------------------------------------
// Worker-compatible interactive browser (select dialogs + widget strip)
//
// prime-agent 0.7.0 runs extension commands in the session worker, where
// ctx.ui.custom is a no-op (the RPC UI bridge forwards only select/confirm/
// input/editor dialogs, notify, setStatus, setWidget(string[]), setTitle).
// The browser below is therefore the primary panel experience: a live widget
// strip above the editor plus select/input dialogs for navigation. The
// HarnessPanel overlay remains the premium path when ctx.ui.custom actually
// invokes its factory (e.g. SDK in-process hosts).
// ---------------------------------------------------------------------------

export interface BrowserRow {
  key: string;
  label: string;
}

const BROWSER_VIEW_LABELS: Record<HarnessView, string> = {
  entries: "entries",
  refinements: "refinements",
  raw: "raw JSON",
};

function entryBrowserLabel(entry: HarnessEntry): string {
  // Compact row: l/g scope badge, [key] reference key, version, title.
  const scope = entry.scope === "local" ? "l" : "g";
  const version = entry.version !== undefined ? ` v${entry.version}` : "";
  const title = (entry.title ?? entry.id).replace(/\s+/g, " ").trim();
  const preview = sanitize(entry.content ?? "").replace(/\s+/g, " ").trim();
  const label = `${scope} [${entry.id}]${version} — ${title}`;
  return preview ? `${label} — ${preview.slice(0, 60)}` : label;
}

/** Rows shown in the main browser dialog for the current view + filter. */
export function buildBrowserRows(data: HarnessData, view: HarnessView, filter: string): BrowserRow[] {
  const rows: BrowserRow[] = [];
  const needle = filter.toLowerCase();
  const matches = (hay: string): boolean => (needle ? hay.toLowerCase().includes(needle) : true);
  if (view === "entries") {
    for (const kind of HARNESS_KINDS) {
      const byMapKey = Object.entries(data.merged.entries[kind]).sort(([, a], [, b]) =>
        compareEntries(a, b),
      );
      const matched: Array<[string, HarnessEntry]> = [];
      for (const [mapKey, entry] of byMapKey) {
        if (!matches([entry.id, entry.kind, entry.path ?? "", entry.title ?? "", entry.content ?? ""].join("\n"))) continue;
        matched.push([mapKey, entry]);
      }
      if (matched.length === 0) continue;
      // Section header per kind — the rows themselves stay compact.
      rows.push({ key: `header:${kind}`, label: `── ${kind} (${matched.length}) ──` });
      for (const [mapKey, entry] of matched) {
        rows.push({ key: `entry:${kind}:${mapKey}`, label: entryBrowserLabel(entry) });
      }
    }
    if (rows.length === 0) {
      rows.push({ key: "empty", label: "(no matching entries — run /refine to create some)" });
    }
  } else if (view === "refinements") {
    for (const rec of data.refinements) {
      if (!matches([rec.id, rec.summary ?? "", rec.trigger ?? "", (rec.changes ?? []).join(" ")].join("\n"))) continue;
      const day = (rec.created_at ?? "").slice(0, 10);
      rows.push({
        key: `refinement:${rec.id}`,
        label: `${rec.scope === "local" ? "l" : "g"} [${rec.id}]${day ? ` ${day}` : ""} — ${(rec.summary ?? rec.trigger ?? "no summary").replace(/\s+/g, " ").slice(0, 80)}`,
      });
    }
    if (rows.length === 0) {
      rows.push({ key: "empty", label: "(no matching refinements)" });
    }
  } else {
    const raw = JSON.stringify({ ...data.merged, refinements: data.refinements }, null, 2);
    for (const line of raw.split("\n").slice(0, 12)) {
      rows.push({ key: `raw:${rows.length}`, label: line.slice(0, 120) || " " });
    }
    rows.push({ key: "raw-more", label: `… ${raw.split("\n").length - 12} more lines` });
  }
  return rows;
}

function detailRecordForRow(data: HarnessData, key: string): string | undefined {
  // Dispatch on the row-key prefix so the [e] expand action keeps working even
  // after the user switches views.
  if (key.startsWith("refinement:")) {
    const id = key.slice("refinement:".length);
    const rec = data.refinements.find((r) => r.id === id);
    return rec ? refinementDetail(rec).join("\n") : undefined;
  }
  // key shape: entry:<kind>:<mapKey> — mapKey is the merged-store key, which
  // carries the `local:` prefix for session entries that collide with global ids.
  const prefix = "entry:";
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const sep = rest.indexOf(":");
  const kind = rest.slice(0, sep);
  const mapKey = rest.slice(sep + 1);
  const entry = (data.merged.entries as Record<string, Record<string, HarnessEntry>>)[kind]?.[mapKey];
  return entry ? entryDetail(entry, mapKey).join("\n") : undefined;
}

/** Interactive browser loop using only worker-supported UI primitives. */
export async function runDialogBrowser(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  data: HarnessData,
  initialFilter?: string,
): Promise<void> {
  let view: HarnessView = "entries";
  let filter = initialFilter ?? "";
  let current = data;

  const widgetKey = "pa-harness-panel";
  const renderWidget = (): void => {
    try {
      const counts = kindCounts(current.merged);
      const total = HARNESS_KINDS.reduce((n, k) => n + counts[k].total, 0);
      const local = HARNESS_KINDS.reduce((n, k) => n + counts[k].local, 0);
      const lines = [
        `harness: ${total} entries (${local} local · ${total - local} global) · ${current.refinements.length} refinements`,
        `view: ${BROWSER_VIEW_LABELS[view]} · filter: ${filter || "none"}`,
        "Enter previews a record · [e] expands last previewed · actions below",
      ];
      ctx.ui.setWidget(widgetKey, lines);
    } catch {
      /* stale ctx */
    }
  };
  const clearWidget = (): void => {
    try {
      ctx.ui.setWidget(widgetKey, undefined);
    } catch {
      /* stale ctx */
    }
  };

  const rowsForView = (): BrowserRow[] => buildBrowserRows(current, view, filter);

  /** Row last opened in the preview editor; [e] expands it to the transcript. */
  let lastPreviewed: { key: string; shortLabel: string } | undefined;

  const refresh = (): void => {
    try {
      const next = collectHarnessData({ sessionManager: ctx.sessionManager, cwd: ctx.cwd });
      if (next.mtimeKey !== current.mtimeKey) current = next;
    } catch {
      /* keep last data */
    }
  };

  const shortLabelFor = (key: string): string => {
    if (key.startsWith("refinement:")) return `refinement [${key.slice("refinement:".length)}]`;
    if (key.startsWith("entry:")) {
      const rest = key.slice("entry:".length);
      const sep = rest.indexOf(":");
      return `${rest.slice(0, sep)} [${rest.slice(sep + 1)}]`;
    }
    return key;
  };

  const openPreview = async (key: string, title: string, content: string): Promise<void> => {
    lastPreviewed = { key, shortLabel: shortLabelFor(key) };
    await ctx.ui.editor(`${title} (Esc to close)`, content);
  };

  try {
    renderWidget();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const viewRows = rowsForView();
      const actionRows: BrowserRow[] = [];
      if (view !== "entries") {
        actionRows.push({ key: "action:view-entries", label: "[1] switch to entries view" });
      } else {
        actionRows.push({ key: "action:view-refinements", label: "[2] switch to refinements view" });
      }
      actionRows.push(
        { key: "action:view-raw", label: "[3] switch to raw JSON view" },
        { key: "action:filter", label: `[/] filter (current: ${filter || "none"})` },
        { key: "action:refresh", label: "[r] refresh from disk" },
      );
      if (lastPreviewed) {
        actionRows.push({
          key: `action:expand:${lastPreviewed.key}`,
          label: `[e] expand last previewed in transcript (${lastPreviewed.shortLabel})`,
        });
      }
      actionRows.push(
        { key: "action:text", label: "[text] print full text report to transcript" },
        { key: "action:raw", label: "[raw] dump merged JSON to transcript" },
        { key: "action:close", label: "[q] close panel" },
      );
      const title = `harness · ${BROWSER_VIEW_LABELS[view]}${filter ? ` · filter: ${filter}` : ""} (${viewRows.length} rows)`;
      const picked = await ctx.ui.select(title, [...viewRows.map((r) => r.label), "── actions ──", ...actionRows.map((r) => r.label)]);
      if (!picked) break; // cancelled → close

      if (picked.startsWith("[")) {
        // action row (or separator)
        const action = actionRows.find((r) => r.label === picked);
        if (!action) continue;
        const verb = action.key.slice("action:".length);
        if (verb === "view-entries") view = "entries";
        else if (verb === "view-refinements") view = "refinements";
        else if (verb === "view-raw") view = "raw";
        else if (verb === "filter") {
          const value = await ctx.ui.input("Filter (id/kind/path/title/content)", filter);
          if (value !== undefined) filter = value;
        } else if (verb === "refresh") refresh();
        else if (verb.startsWith("expand:") && lastPreviewed) {
          // Expand the last previewed record into the transcript (explicit, rare).
          const detail = detailRecordForRow(current, lastPreviewed.key);
          if (detail) sendHarnessReport(pi, ctx, detail);
        } else if (verb === "text") sendHarnessReport(pi, ctx, formatTextReport(current));
        else if (verb === "raw") sendHarnessReport(pi, ctx, formatRawJson(current));
        else if (verb === "close") break;
        renderWidget();
        continue;
      }

      // Row pick: Enter on a row opens the in-panel preview directly — nothing
      // is ever imported unless the user explicitly picks the [e] action.
      const key = viewRows.find((r) => r.label === picked)?.key;
      if (!key || key.startsWith("action:") || key.startsWith("header:")) continue;
      if (view === "raw") {
        await openPreview("raw", "harness · raw JSON (preview — not imported)", formatRawJson(current));
        continue;
      }
      const detail = detailRecordForRow(current, key);
      if (!detail) continue;
      await openPreview(key, `preview · ${shortLabelFor(key)}`, detail);
    }
  } finally {
    clearWidget();
  }
}

function sendHarnessReport(
  pi: ExtensionAPI,
  ctx: { isIdle?: () => boolean },
  text: string,
): void {
  if (ctx.isIdle?.()) {
    // Idle: append + render immediately (no LLM turn).
    pi.sendMessage({ customType: "harness_report", content: text, display: true, details: {} });
  } else {
    // Streaming: queue for the next turn so we never steer the model.
    pi.sendMessage(
      { customType: "harness_report", content: text, display: true, details: {} },
      { deliverAs: "nextTurn" },
    );
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function harnessPanel(pi: ExtensionAPI): void {
  /** Overlay panel currently open (for refine_complete live refresh). */
  let openPanel: HarnessPanel | undefined;

  function collect(ctx: ExtensionCommandContext): HarnessData {
    return collectHarnessData({
      sessionManager: ctx.sessionManager,
      cwd: ctx.cwd,
    });
  }

  pi.registerCommand("harness", {
    description:
      "Open the continual-harness panel (prompt/memory/skill/subagent entries + refinements); args: [filter] | raw | text",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      const initialFilter = arg && arg !== "raw" && arg !== "text" ? arg : undefined;

      // Non-interactive paths: transcript reports.
      if (arg === "raw" || arg === "text" || !ctx.hasUI) {
        const data = collect(ctx);
        sendHarnessReport(pi, ctx, arg === "raw" ? formatRawJson(data) : formatTextReport(data));
        return;
      }

      // Premium path: full-screen overlay when the host actually implements
      // ctx.ui.custom (in-process SDK hosts). prime-agent 0.7.0 CLI workers
      // return a no-op custom(), so factoryRan stays false and we fall back
      // to the dialog browser below.
      let factoryRan = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            factoryRan = true;
            let data = collect(ctx);
            const palette = createPalette(theme);
            const refresh = (): boolean => {
              try {
                const next = collect(ctx);
                if (next.mtimeKey !== data.mtimeKey) {
                  data = next;
                  return true;
                }
              } catch {
                // stale context after session teardown — keep last data
              }
              return false;
            };
            const panel = new HarnessPanel({
              data,
              palette,
              requestRender: () => {
                try {
                  tui.requestRender();
                } catch {
                  /* teardown race */
                }
              },
              onClose: () => {
                openPanel = undefined;
                done(undefined);
              },
              onRefresh: refresh,
              initialFilter,
            });
            openPanel = panel;
            timer = setInterval(() => {
              try {
                if (panel.disposed) {
                  if (timer) clearInterval(timer);
                  return;
                }
                if (refresh()) panel.invalidate();
                tui.requestRender();
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 2000);
            timer.unref?.();
            return panel;
          },
          {
            overlay: true,
            overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center" },
          },
        );
      } catch (err) {
        if (factoryRan) {
          ctx.ui.notify?.(
            `harness panel error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        if (timer) clearInterval(timer);
      }

      // Worker-compatible interactive browser (select dialogs + widget strip).
      if (!factoryRan) {
        const data = collect(ctx);
        await runDialogBrowser(pi, ctx, data, initialFilter);
      }
    },
  });

// Live-refresh the open panel the moment /refine lands.
  pi.on("refine_complete", () => {
    try {
      openPanel?.refreshNow();
    } catch {
      openPanel = undefined;
    }
  });
}
