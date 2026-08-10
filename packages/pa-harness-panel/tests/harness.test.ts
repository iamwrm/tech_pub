import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  parseHarnessState,
  mergeHarnessStates,
  parseRefinementsJsonl,
  sessionRefinementRecords,
  mergeRefinementRecords,
  collectHarnessData,
  formatTextReport,
  formatRawJson,
  wrapToWidth,
  createPalette,
  HarnessPanel,
  framePanel,
  colorizeJson,
} from "../index.ts";
import type { HarnessData, HarnessState, RefinementRecord } from "../index.ts";
import {
  buildBrowserRows,
  runDialogBrowser,
} from "../index.ts";

const PASSTHROUGH_PALETTE = createPalette(undefined);

function fixtureState(): HarnessState {
  return {
    schema: 1,
    entries: {
      prompt: {},
      memory: {
        "astro-task": {
          id: "astro-task",
          kind: "memory",
          title: "AstroPaper task state",
          content: "Repo: /ssd/gh/astro-paper-on-vercel. All work shipped and pushed at 60b5ad3.\nVercel auto-deploys on push.",
          path: "local/task-state",
          scope: "local",
          reference: {},
          arguments: {},
          metadata: { scope: "local", version: 5 },
          source: "refine",
          created_at: "2026-08-06T06:08:18.016Z",
          updated_at: "2026-08-06T10:36:40.817Z",
          version: 5,
        },
      },
      skill: {
        "astro-hygiene": {
          id: "astro-hygiene",
          kind: "skill",
          title: "AstroPaper content hygiene",
          content: '"""AstroPaper helpers"""\n\ndef find_duplicate_h1s(blog_dir): ...',
          scope: "global",
          reference: {
            type: "python",
            import: "astro_blog_tools",
            callable: "find_duplicate_h1s",
            call_pattern: "await find_duplicate_h1s(blog_dir)",
          },
          arguments: {
            blog_dir: { type: "string", required: true, description: "blog content dir" },
          },
          metadata: {},
          created_at: "2026-08-06T07:00:00.000Z",
          updated_at: "2026-08-06T07:00:00.000Z",
          version: 1,
        },
      },
      subagent: {},
    },
    refinements: [
      {
        id: "refine_20260806060737343",
        trigger: "Record local session state",
        changes: ["create memory:astro-task"],
        evidence: "trajectory evidence",
        outcome: "pick up next turn",
        created_at: "2026-08-06T06:08:18.016Z",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// parse / merge semantics (mirrors refinement.js)
// ---------------------------------------------------------------------------

test("parseHarnessState normalizes entries and survives corrupt input", () => {
  const state = parseHarnessState(JSON.stringify(fixtureState()), "local");
  assert.equal(state.schema, 1);
  const mem = state.entries.memory["astro-task"];
  assert.equal(mem.scope, "local");
  assert.deepEqual(mem.reference, {});
  assert.equal(state.entries.skill["astro-hygiene"].scope, "global");
  assert.equal(state.refinements.length, 1);

  // corrupt / non-object payloads degrade to empty, never throw
  assert.deepEqual(parseHarnessState("not json {", "local"), { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] });
  assert.deepEqual(parseHarnessState("[]", "global"), { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] });
  assert.deepEqual(parseHarnessState("null", "local"), { schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] });
});

test("mergeHarnessStates overlays local and prefixes local:<id> on collision", () => {
  const mk = (scope: "local" | "global"): HarnessState => ({
    schema: 1,
    entries: {
      prompt: {},
      memory: {
        "shared-id": {
          id: "shared-id",
          kind: "memory",
          title: scope === "global" ? "G" : "L",
          scope,
          reference: {},
          arguments: {},
          metadata: {},
        },
      },
      skill: {},
      subagent: {},
    },
    refinements: [],
  });
  const merged = mergeHarnessStates(mk("global"), mk("local"));
  assert.ok(merged.entries.memory["shared-id"]);
  assert.equal(merged.entries.memory["shared-id"].scope, "global");
  assert.equal(merged.entries.memory["shared-id"].title, "G");
  assert.ok(merged.entries.memory["local:shared-id"]);
  assert.equal(merged.entries.memory["local:shared-id"].scope, "local");
  assert.equal(merged.entries.memory["local:shared-id"].title, "L");
  assert.equal(Object.keys(merged.entries.memory).length, 2);

  // no collision -> plain ids
  const localOnly = mergeHarnessStates(undefined, fixtureState());
  assert.ok(localOnly.entries.memory["astro-task"]);
  assert.equal(localOnly.entries.memory["astro-task"].scope, "local");
  assert.ok(localOnly.entries.skill["astro-hygiene"]);
});

test("mergeHarnessStates concatenates refinement logs", () => {
  const g = fixtureState();
  const l = fixtureState();
  const merged = mergeHarnessStates(g, l);
  assert.equal(merged.refinements.length, 2);
});

// ---------------------------------------------------------------------------
// refinement records
// ---------------------------------------------------------------------------

test("parseRefinementsJsonl skips malformed lines and defaults scope", () => {
  const text = [
    JSON.stringify({ id: "r1", summary: "one", appliedEdits: [] }),
    "garbage line",
    JSON.stringify({ id: "r2", scope: "global", created_at: "2026-08-06T00:00:00Z" }),
    "",
  ].join("\n");
  const recs = parseRefinementsJsonl(text, "global");
  assert.equal(recs.length, 2);
  assert.equal(recs[0].scope, "global");
  assert.equal(recs[1].scope, "global");
});

test("sessionRefinementRecords extracts prime-agent.refinement custom entries", () => {
  const entries = [
    { type: "message", id: "m1" },
    {
      type: "custom",
      customType: "prime-agent.refinement",
      data: {
        id: "refine_x",
        summary: "local refine",
        scope: "local",
        harnessStatePath: "/tmp/harness_state.json",
        appliedEdits: [{ action: "create", kind: "memory", id: "foo", applied: true }],
      },
    },
    { type: "custom", customType: "something.else", data: { id: "y" } },
  ];
  const recs = sessionRefinementRecords(entries);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, "refine_x");
  assert.equal(recs[0].scope, "local");
  assert.equal(recs[0].harnessStatePath, "/tmp/harness_state.json");
});

test("mergeRefinementRecords de-dupes by id with session winning", () => {
  const global: RefinementRecord[] = [
    { id: "r1", scope: "global", summary: "g" },
    { id: "r2", scope: "global", summary: "old" },
  ];
  const session: RefinementRecord[] = [
    { id: "r2", scope: "local", summary: "new" },
  ];
  const merged = mergeRefinementRecords(global, session);
  assert.equal(merged.length, 2);
  const r2 = merged.find((r) => r.id === "r2");
  assert.equal(r2?.summary, "new");
});

// ---------------------------------------------------------------------------
// collectHarnessData against a real temp agent dir
// ---------------------------------------------------------------------------

test("collectHarnessData merges global + local files and tracks mtimeKey", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pa-harness-"));
  try {
    const agentDir = join(dir, "agent");
    const artifactDir = join(dir, "session-artifacts", "sess-1");
    mkdirSync(join(agentDir, "harness"), { recursive: true });
    mkdirSync(join(artifactDir, "harness"), { recursive: true });
    writeFileSync(
      join(agentDir, "harness", "harness_state.json"),
      JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { gm: { id: "gm", kind: "memory", scope: "global", title: "G" } }, skill: {}, subagent: {} }, refinements: [] }),
    );
    writeFileSync(
      join(agentDir, "harness", "refinements.jsonl"),
      JSON.stringify({ id: "rg1", summary: "global refine", scope: "global" }) + "\n",
    );
    writeFileSync(
      join(artifactDir, "harness", "harness_state.json"),
      JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { gm: { id: "gm", kind: "memory", scope: "local", title: "L" } }, skill: {}, subagent: {} }, refinements: [] }),
    );
    const sm = {
      getSessionDir: () => join(dir, "sessions"),
      getSessionId: () => "sess-1",
      getSessionName: () => undefined,
      getEntries: () => [
        {
          type: "custom",
          customType: "prime-agent.refinement",
          data: { id: "rs1", summary: "session refine", scope: "local" },
        },
      ],
    };
    const data = collectHarnessData({ sessionManager: sm, cwd: "/tmp" }, agentDir);

    // collision -> local:gm
    assert.ok(data.merged.entries.memory["gm"]);
    assert.equal(data.merged.entries.memory["gm"].scope, "global");
    assert.equal(data.merged.entries.memory["local:gm"].scope, "local");
    // global jsonl + session custom entries merged
    assert.equal(data.refinements.length, 2);
    assert.ok(data.refinements.some((r) => r.id === "rg1"));
    assert.ok(data.refinements.some((r) => r.id === "rs1"));
    assert.ok(data.mtimeKey.includes("sess-1"));

    // mtimeKey changes when the local file is touched
    const before = data.mtimeKey;
    await new Promise((r) => setTimeout(r, 25));
    writeFileSync(
      join(artifactDir, "harness", "harness_state.json"),
      JSON.stringify({ schema: 1, entries: { prompt: {}, memory: { gm: { id: "gm", kind: "memory", scope: "local", title: "L2" } }, skill: {}, subagent: {} }, refinements: [] }),
    );
    const data2 = collectHarnessData({ sessionManager: sm, cwd: "/tmp" }, agentDir);
    assert.notEqual(data2.mtimeKey, before);
    assert.equal(data2.merged.entries.memory["local:gm"].title, "L2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// text formatting
// ---------------------------------------------------------------------------

test("formatTextReport is readable and contains counts, titles, refinements", () => {
  const data: HarnessData = {
    merged: fixtureState(),
    refinements: [
      { id: "refine_20260806060737343", scope: "local", created_at: "2026-08-06T06:08:18.016Z", summary: "Record local session state", changes: ["create memory:astro-task"] },
    ],
    sources: { agentDir: "/tmp", globalEntriesPath: "/tmp/harness/harness_state.json", localEntriesPath: "/tmp/art/harness/harness_state.json" },
    mtimeKey: "x",
    sessionId: "sess-1",
    sessionName: "astro",
  };
  const report = formatTextReport(data);
  assert.ok(report.includes("memory 1 (1 local)"));
  assert.ok(report.includes("skill 1 (1 global)"));
  assert.ok(report.includes("AstroPaper task state"));
  assert.ok(report.includes("refine_20260806060737343"));
  assert.ok(report.includes("reference:"));
});

test("formatRawJson is valid JSON containing entries and refinements", () => {
  const data: HarnessData = {
    merged: fixtureState(),
    refinements: [{ id: "r1", scope: "local" }],
    sources: { agentDir: "/tmp" },
    mtimeKey: "x",
  };
  const raw = formatRawJson(data);
  const parsed = JSON.parse(raw) as { entries: HarnessState["entries"]; refinements: unknown[] };
  assert.ok(parsed.entries.memory["astro-task"]);
  assert.equal(parsed.refinements.length, 1);
});

// ---------------------------------------------------------------------------
// wrapping
// ---------------------------------------------------------------------------

test("wrapToWidth preserves word spacing and newlines", () => {
  const text = "Repo /ssd/gh/astro-paper-on-vercel: Astro 5.5.2 static site (AstroPaper theme, blog.ren15.com), Tailwind 3.4,";
  const lines = wrapToWidth(text, 120);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], text);
  const joined = wrapToWidth(text, 60).join("\n");
  // every space survives wrapping
  assert.equal(joined.replace(/\n/g, ""), text);
});

test("wrapToWidth never exceeds max visible width (incl. CJK)", () => {
  const text = "The quick brown fox jumps over the lazy dog. " +
    "https://example.com/very-long-unbreakable-url-" + "x".repeat(60) + " " +
    "中文文字測試 with emoji 🎉 and more text";
  for (const line of wrapToWidth(text, 40)) {
    assert.ok(visibleWidth(line) <= 40, `line too wide (${visibleWidth(line)}): ${line.slice(0, 20)}`);
  }
  // preserves newlines
  const lines = wrapToWidth("a\nb\nc", 10);
  assert.deepEqual(lines, ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// panel component
// ---------------------------------------------------------------------------

function makePanel(overrides: Partial<ConstructorParameters<typeof HarnessPanel>[0]> = {}) {
  const data: HarnessData = {
    merged: fixtureState(),
    refinements: [
      { id: "refine_20260806060737343", scope: "local", created_at: "2026-08-06T06:08:18.016Z", summary: "Record local session state", trigger: "Record local session state", changes: ["create memory:astro-task"], rationale: "because evidence", expectedOutcome: "pick up later", evidence: "trajectory shows it", outcome: "n/a" },
      { id: "refine_2", scope: "global", created_at: "2026-08-05T00:00:00Z", summary: "Older global refine", changes: ["update skill:astro-hygiene"] },
    ],
    sources: { agentDir: "/tmp" },
    mtimeKey: "x",
    sessionId: "sess-1",
    sessionName: "astro",
  };
  let closed = false;
  const panel = new HarnessPanel({
    data,
    palette: PASSTHROUGH_PALETTE,
    requestRender: () => {},
    onClose: () => {
      closed = true;
    },
    ...overrides,
  });
  return { panel, data, getClosed: () => closed };
}

test("panel render obeys the width contract and shows counts + rows", () => {
  const { panel } = makePanel();
  const lines = panel.render(100);
  // every line fits the requested width (ANSI-aware)
  for (const line of lines) assert.ok(visibleWidth(line) <= 100, JSON.stringify(line.slice(0, 30)));
  const joined = lines.join("\n");
  assert.ok(joined.includes("HARNESS entries"));
  assert.ok(joined.includes("memory"));
  assert.ok(joined.includes("AstroPaper task state"));
  assert.ok(joined.includes("refinements"));
});

test("panel keyboard flow: move, expand, filter, views, close", () => {
  const { panel, getClosed } = makePanel();
  const W = 100;

  // initial: cursor on first item; enter expands -> detail content appears
  panel.handleInput("\r");
  let joined = panel.render(W).join("\n");
  assert.ok(joined.includes("content:"));
  assert.ok(joined.includes("Repo: /ssd/gh/astro-paper-on-vercel"));
  panel.handleInput("\r"); // collapse
  joined = panel.render(W).join("\n");
  assert.ok(!joined.includes("content:"));

  // move down twice (kind header not selectable): memory item -> skill item
  panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  joined = panel.render(W).join("\n");
  assert.ok(joined.includes("reference:"));
  assert.ok(joined.includes("arguments:"));
  assert.ok(joined.includes("blog_dir"));
  panel.handleInput("\x1b"); // close
  assert.ok(getClosed());
});

test("panel filter narrows rows and escape exits filter mode", () => {
  const { panel } = makePanel();
  panel.handleInput("/");
  for (const ch of "astro-hygiene") panel.handleInput(ch);
  let joined = panel.render(100).join("\n");
  assert.ok(!joined.includes("AstroPaper task state"));
  assert.ok(joined.includes("AstroPaper content hygiene"));
  panel.handleInput("\x1b"); // leave filter mode (panel stays open)
  panel.handleInput("\x1b"); // close panel
});

test("panel refinements view and raw view render", () => {
  const { panel } = makePanel();
  panel.handleInput("2");
  let joined = panel.render(100).join("\n");
  assert.ok(joined.includes("refine_20260806060737343"));
  assert.ok(joined.includes("Older global refine"));

  // expand a refinement -> rationale/evidence visible
  panel.handleInput("\r");
  joined = panel.render(100).join("\n");
  assert.ok(joined.includes("rationale:"));
  assert.ok(joined.includes("because evidence"));

  panel.handleInput("3");
  joined = panel.render(100).join("\n");
  assert.ok(joined.includes('"schema"'));
  assert.ok(joined.includes('"astro-task"'));
});

test("panel refreshNow picks up changed data and reports it", () => {
  let current = makePanel().data;
  let refreshCalls = 0;
  const panel = new HarnessPanel({
    data: current,
    palette: PASSTHROUGH_PALETTE,
    requestRender: () => {},
    onClose: () => {},
    onRefresh: () => {
      refreshCalls += 1;
      const changed = makePanel().data;
      changed.merged.entries.memory["astro-task"] = {
        ...changed.merged.entries.memory["astro-task"]!,
        title: "UPDATED TITLE",
      };
      const next = changed;
      const didChange = next.mtimeKey !== current.mtimeKey;
      current = next;
      return didChange;
    },
  });
  // mtimeKey identical -> no change reported
  assert.equal(panel.refreshNow(), false);
  assert.equal(refreshCalls, 1);
});

test("framePanel pads interior lines to full width (overlay opacity)", () => {
  const lines = framePanel("TEST", ["abc", "a".repeat(30)], 40, PASSTHROUGH_PALETTE);
  assert.equal(lines.length, 4);
  assert.equal(visibleWidth(lines[1]), 40);
  assert.equal(visibleWidth(lines[2]), 40);
});

test("colorizeJson leaves JSON parseable when ANSI is stripped", () => {
  const json = JSON.stringify({ schema: 1, entries: { memory: { a: { id: "a", n: 42, ok: true } } }, refinements: [] }, null, 2);
  const colored = colorizeJson(json, PASSTHROUGH_PALETTE);
  // passthrough palette adds no ANSI
  assert.equal(colored, json);
  assert.deepEqual(JSON.parse(colored), JSON.parse(json));
});


// ---------------------------------------------------------------------------
// dialog browser (worker-compatible panel)
// ---------------------------------------------------------------------------

function browserData(): HarnessData {
  return {
    merged: fixtureState(),
    refinements: [
      { id: "refine_20260806060737343", scope: "local", created_at: "2026-08-06T06:08:18.016Z", summary: "Record local session state", changes: ["create memory:astro-task"] },
    ],
    sources: { agentDir: "/tmp" },
    mtimeKey: "x",
    sessionId: "sess-1",
  };
}

test("buildBrowserRows lists entries with scope, then refinements, then raw", () => {
  const data = browserData();
  const entries = buildBrowserRows(data, "entries", "");
  // section headers per kind, compact l/g scope + [key] rows
  assert.ok(entries.some((r) => r.label.includes("── memory (1) ──")));
  assert.ok(entries.some((r) => r.label.includes("── skill (1) ──")));
  assert.ok(entries.some((r) => r.label.startsWith("l [astro-task] v5 — AstroPaper task state — Repo: /ssd/gh/astro-paper-on-vercel.")));
  assert.ok(entries.some((r) => r.label.startsWith("g [astro-hygiene]")));
  // headers are inert: no entry keys under header: rows
  assert.ok(entries.find((r) => r.label.includes("── memory"))?.key.startsWith("header:"));

  const refs = buildBrowserRows(data, "refinements", "");
  assert.equal(refs.length, 1);
  assert.ok(refs[0].label.startsWith("l [refine_20260806060737343]"));

  const raw = buildBrowserRows(data, "raw", "");
  assert.ok(raw.some((r) => r.label.includes('"schema"')));
});

test("local: colliding entries keep the merged map key in browser rows", () => {
  // merged state with a global id and a local collision -> local:<id>
  const g = browserData();
  const localState = JSON.parse(JSON.stringify(browserData().merged)) as HarnessState;
  localState.entries.memory["astro-task"] = {
    id: "astro-task", kind: "memory", title: "local override",
    content: "override body", path: "local/task-state", scope: "local",
    reference: {}, arguments: {}, metadata: {}, source: "refine",
    created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:00:00.000Z", version: 1,
  };
  const data: HarnessData = {
    merged: mergeHarnessStates(g.merged, localState),
    refinements: [],
    sources: { agentDir: "/tmp" },
    mtimeKey: "x",
  };
  const rows = buildBrowserRows(data, "entries", "override");
  // header row + the single matching entry row
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, "header:memory");
  // the row key is the merged map key (local: prefix preserved), and the label
  // shows the bare id as the reference key
  assert.ok(rows[1].key.startsWith("entry:memory:local:"));
  assert.ok(rows[1].label.startsWith("l [astro-task]"));
});

test("buildBrowserRows applies filters", () => {
  const data = browserData();
  const entries = buildBrowserRows(data, "entries", "hygiene");
  assert.ok(entries.length > 0);
  assert.ok(entries.every((r) => r.key.startsWith("header:") || r.label.toLowerCase().includes("hygiene") || r.key.startsWith("empty")));
  const none = buildBrowserRows(data, "entries", "zzz-no-match");
  assert.equal(none.length, 1);
  assert.equal(none[0].key, "empty");
});

test("runDialogBrowser: Enter previews, [e] expands last previewed, close clears widget", async () => {
  const data = browserData();
  const dialogs: Array<{ title: string; options: string[] }> = [];
  const widgets: Array<string[] | undefined> = [];
  let widgetKey: string | undefined;
  const editors: Array<{ title: string; content: string }> = [];
  const sent: Array<{ customType: string; content: string }> = [];

  // Scripted user: pick the memory entry (Enter = preview), then [e] expands
  // the last previewed record to the transcript, then close.
  const script: Array<() => string | undefined> = [
    () => dialogs[0]?.options.find((o) => o.includes("AstroPaper task state")),
    () => dialogs[1]?.options.find((o) => o.startsWith("[e]")),
    () => "[q] close panel",
  ];
  const fakeCtx = {
    hasUI: true,
    sessionManager: {
      getSessionDir: () => "/tmp/sessions",
      getSessionId: () => "sess-1",
      getEntries: () => [],
    },
    cwd: "/tmp",
    ui: {
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });
        return script.shift()?.();
      },
      input: async () => undefined,
      editor: async (title: string, content: string) => {
        editors.push({ title, content });
        return undefined;
      },
      setWidget: (key: string, lines: string[] | undefined) => {
        widgetKey = key;
        widgets.push(lines);
      },
      notify: () => {},
    },
  };
  const fakePi = {
    sendMessage: (msg: { customType: string; content: string }) => {
      sent.push({ customType: msg.customType, content: msg.content });
    },
  };

  await runDialogBrowser(fakePi as never, fakeCtx as never, data);

  // Enter on the row opened the preview directly — no intermediate detail dialog
  assert.equal(editors.length, 1);
  assert.ok(editors[0].content.includes("Repo: /ssd/gh/astro-paper-on-vercel"));
  assert.ok(editors[0].title.startsWith("preview"));
  // the [e] action row appeared after the preview and expanded the same record
  assert.ok(dialogs[1]?.options.some((o) => o.startsWith("[e] expand last previewed")));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].customType, "harness_report");
  assert.ok(sent[0].content.includes("Repo: /ssd/gh/astro-paper-on-vercel"));
  // widget was set then cleared
  assert.equal(widgetKey, "pa-harness-panel");
  assert.ok(widgets[0]?.some((l) => l.includes("harness:")));
  assert.equal(widgets[widgets.length - 1], undefined);
});

test("runDialogBrowser: Enter on a raw row previews instead of dumping to transcript", async () => {
  const data = browserData();
  const dialogs: Array<{ options: string[] }> = [];
  const editors: Array<{ content: string }> = [];
  const sent: string[] = [];
  const script: Array<() => string | undefined> = [
    () => "[3] switch to raw JSON view",
    () => dialogs[1]?.options.find((o) => o.includes('"schema"')),
    () => "[q] close panel",
  ];
  const fakeCtx = {
    hasUI: true,
    sessionManager: { getSessionDir: () => "/tmp/sessions", getSessionId: () => "sess-1", getEntries: () => [] },
    cwd: "/tmp",
    ui: {
      select: async (_title: string, options: string[]) => {
        dialogs.push({ options });
        return script.shift()?.();
      },
      input: async () => undefined,
      editor: async (_title: string, content: string) => {
        editors.push({ content });
        return undefined;
      },
      setWidget: () => {},
      notify: () => {},
    },
  };
  const fakePi = {
    sendMessage: (msg: { customType: string; content: string }) => {
      if (msg.customType === "harness_report") sent.push(msg.content);
    },
  };
  await runDialogBrowser(fakePi as never, fakeCtx as never, data);
  assert.equal(editors.length, 1);
  JSON.parse(editors[0].content); // full JSON shown in the preview
  assert.equal(sent.length, 0); // nothing imported
});

test("runDialogBrowser view switch + filter + raw dump actions", async () => {
  const data = browserData();
  const script = [
    "[2] switch to refinements view",
    "[3] switch to raw JSON view",
    "[raw] dump merged JSON to transcript",
    "[q] close panel",
  ];
  const dialogs: Array<{ title: string }> = [];
  const sent: string[] = [];
  const fakeCtx = {
    hasUI: true,
    sessionManager: { getSessionDir: () => "/tmp/sessions", getSessionId: () => "sess-1", getEntries: () => [] },
    cwd: "/tmp",
    ui: {
      select: async (title: string) => {
        dialogs.push({ title });
        return script.shift() ?? undefined;
      },
      input: async () => undefined,
      editor: async () => undefined,
      setWidget: () => {},
      notify: () => {},
    },
  };
  const fakePi = {
    sendMessage: (msg: { customType: string; content: string }) => {
      if (msg.customType === "harness_report") sent.push(msg.content);
    },
  };
  await runDialogBrowser(fakePi as never, fakeCtx as never, data);
  // switched to refinements view (dialog title mentions it) and raw view
  assert.ok(dialogs.some((d) => d.title.includes("refinements")));
  assert.ok(dialogs.some((d) => d.title.includes("raw JSON")));
  // raw dump was sent and parses
  assert.equal(sent.length, 1);
  JSON.parse(sent[0]);
});
