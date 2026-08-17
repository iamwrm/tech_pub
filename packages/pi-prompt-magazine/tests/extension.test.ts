import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activatePromptMagazine } from "../index.ts";
import { pushStash } from "../magazine.ts";
import Database from "better-sqlite3";
import { MagazineStorage } from "../storage.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
type Command = { handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown> };
type SelectResponse = string | undefined | ((title: string, options: string[]) => string | undefined);

interface FakeSession {
  id: string;
  file?: string;
  cwd: string;
  branch: any[];
  persisted?: boolean;
  parentSession?: string;
  mode?: "tui" | "print" | "rpc";
}

interface FakeUiState {
  widgets: Map<string, string[] | undefined>;
  notifications: Array<{ message: string; level: string }>;
  editorText: string;
  selectResponses: SelectResponse[];
  selectCalls: Array<{ title: string; options: string[] }>;
  confirmResponses: boolean[];
  customInputs: string[][];
  customRenders: string[][][];
}

interface Harness {
  handlers: Map<string, Handler[]>;
  commands: Map<string, Command>;
  appended: Array<{ customType: string; data: unknown }>;
  ui: FakeUiState;
  ctx: ExtensionContext;
  emit: (name: string, event?: any) => Promise<unknown[]>;
  command: (name: string, args?: string) => Promise<void>;
}

function makeHarness(session: FakeSession, databasePath: string, refreshIntervalMs = 0): Harness {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const ui: FakeUiState = {
    widgets: new Map(),
    notifications: [],
    editorText: "",
    selectResponses: [],
    selectCalls: [],
    confirmResponses: [],
    customInputs: [],
    customRenders: [],
  };

  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: session.cwd,
    mode: session.mode ?? "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getBranch: () => session.branch,
      getHeader: () => ({ parentSession: session.parentSession }),
      isPersisted: () => session.persisted ?? true,
    },
    ui: {
      setWidget(key: string, value: string[] | undefined) {
        ui.widgets.set(key, value ? [...value] : undefined);
      },
      notify(message: string, level: string) {
        ui.notifications.push({ message, level });
      },
      setEditorText(text: string) {
        ui.editorText = text;
      },
      async select(title: string, options: string[]) {
        ui.selectCalls.push({ title, options: [...options] });
        const response = ui.selectResponses.shift();
        return typeof response === "function" ? response(title, options) : response;
      },
      async confirm() {
        return ui.confirmResponses.shift() ?? false;
      },
      async editor(_title: string, text: string) {
        return text;
      },
      async custom(factory: any) {
        let result: unknown;
        const renders: string[][] = [];
        const tui = {
          terminal: { rows: 30, columns: 100 },
          requestRender() {},
        };
        const theme = {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        };
        const component = factory(tui, theme, {}, (value: unknown) => { result = value; });
        renders.push(component.render(80));
        for (const input of ui.customInputs.shift() ?? ["\x1b"]) {
          component.handleInput?.(input);
          renders.push(component.render(80));
        }
        ui.customRenders.push(renders);
        return result;
      },
    },
  } as unknown as ExtensionContext;

  activatePromptMagazine(pi, { databasePath, refreshIntervalMs });

  return {
    handlers,
    commands,
    appended,
    ui,
    ctx,
    async emit(name: string, event: any = { type: name }) {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    async command(name: string, args = "") {
      const registered = commands.get(name);
      if (!registered) throw new Error(`command not registered: ${name}`);
      await registered.handler(args, ctx);
    },
  };
}

function fixture(): { dir: string; databasePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-prompt-magazine-extension-"));
  return {
    dir,
    databasePath: join(dir, "magazine.sqlite3"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function widgetText(harness: Harness): string {
  return (harness.ui.widgets.get("pi-prompt-magazine") ?? []).join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("interactive capture survives a reconstructed extension instance on /reload", async () => {
  const f = fixture();
  try {
    const session: FakeSession = {
      id: "reload-session",
      file: join(f.dir, "reload.jsonl"),
      cwd: f.dir,
      branch: [],
    };
    const first = makeHarness(session, f.databasePath);
    await first.emit("session_start", { type: "session_start", reason: "startup" });
    const [result] = await first.emit("input", {
      type: "input",
      source: "interactive",
      text: "keep this draft;;",
    });
    assert.deepEqual(result, { action: "handled" });
    assert.match(widgetText(first), /keep this draft/);
    assert.equal(first.appended.length, 0, "new writes must not use pi.appendEntry");
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    const reloaded = makeHarness(session, f.databasePath);
    await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
    assert.match(widgetText(reloaded), /keep this draft/);
    await reloaded.command("magazine", "1");
    assert.equal(reloaded.ui.editorText, "keep this draft");
    assert.equal(widgetText(reloaded), "");
    await reloaded.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("historical magazine custom entries in session logs are ignored", async () => {
  const f = fixture();
  try {
    const session: FakeSession = {
      id: "old-log-session",
      file: join(f.dir, "old-log.jsonl"),
      cwd: f.dir,
      branch: [
        { type: "custom", customType: "pi-prompt-magazine", data: { v: 2, kind: "add", text: "old draft" } },
      ],
    };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(widgetText(harness), "");

    await harness.command("stash", "current SQLite draft");
    await harness.emit("session_tree", { type: "session_tree" });
    assert.match(widgetText(harness), /current SQLite draft/);
    assert.doesNotMatch(widgetText(harness), /old draft/);
    assert.equal(harness.appended.length, 0);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("forks copy their parent magazine once and remain session-isolated", async () => {
  const f = fixture();
  try {
    const parent: FakeSession = {
      id: "parent",
      file: join(f.dir, "parent.jsonl"),
      cwd: f.dir,
      branch: [],
    };
    const parentHarness = makeHarness(parent, f.databasePath);
    await parentHarness.emit("session_start", { type: "session_start", reason: "startup" });
    await parentHarness.command("stash", "inherited");
    await parentHarness.emit("session_shutdown", { type: "session_shutdown", reason: "fork" });

    const child: FakeSession = {
      id: "child",
      file: join(f.dir, "child.jsonl"),
      cwd: f.dir,
      branch: [],
    };
    const childHarness = makeHarness(child, f.databasePath);
    await childHarness.emit("session_start", {
      type: "session_start",
      reason: "fork",
      previousSessionFile: parent.file,
    });
    assert.match(widgetText(childHarness), /inherited/);
    await childHarness.command("stash", "child only");
    await childHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const resumedParent = makeHarness(parent, f.databasePath);
    await resumedParent.emit("session_start", { type: "session_start", reason: "resume" });
    assert.match(widgetText(resumedParent), /inherited/);
    assert.doesNotMatch(widgetText(resumedParent), /child only/);
    await resumedParent.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("failed SQLite capture is handled, restored to the editor, and never sent", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "failure", cwd: f.dir, branch: [] };
    const harness = makeHarness(session, f.dir, 0); // A directory cannot be opened as a SQLite database file.
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    const [result] = await harness.emit("input", {
      type: "input",
      source: "interactive",
      text: "do not lose or send me;;",
    });
    assert.deepEqual(result, { action: "handled" });
    assert.equal(harness.ui.editorText, "do not lose or send me;;");
    assert.ok(harness.ui.notifications.some(({ level }) => level === "error"));
    assert.equal(harness.appended.length, 0);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("non-interactive inputs pass through and the ;;; escape remains a transform", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "inputs", cwd: f.dir, branch: [] };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    const [rpc] = await harness.emit("input", { type: "input", source: "rpc", text: "rpc;;" });
    const [escaped] = await harness.emit("input", {
      type: "input",
      source: "interactive",
      text: "literal;;;",
    });
    assert.deepEqual(rpc, { action: "continue" });
    assert.deepEqual(escaped, { action: "transform", text: "literal;;" });
    assert.equal(widgetText(harness), "");
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("bare ;; opens the same magazine browser and is never sent", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "bare-marker", file: join(f.dir, "bare.jsonl"), cwd: f.dir, branch: [] };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("stash", "open me from the marker");
    harness.ui.selectResponses.push(undefined);

    const [result] = await harness.emit("input", {
      type: "input",
      source: "interactive",
      text: "  ;;  ",
    });
    assert.deepEqual(result, { action: "handled" });
    assert.equal(harness.ui.selectCalls.length, 1);
    assert.match(harness.ui.selectCalls[0].title, /^Magazine — 1 stashed/);
    assert.ok(harness.ui.selectCalls[0].options.some((option) => option.includes("open me from the marker")));
    const [withImage] = await harness.emit("input", {
      type: "input",
      source: "interactive",
      text: ";;",
      images: [{}],
    });
    assert.deepEqual(withImage, { action: "continue" });
    assert.equal(harness.ui.selectCalls.length, 1);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("order mode replaces move actions and reorders multiple selected entries", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "order-mode", file: join(f.dir, "order.jsonl"), cwd: f.dir, branch: [] };
    const identity = { sessionId: session.id, sessionFile: session.file, cwd: session.cwd };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("stash", "alpha");
    await harness.command("stash", "bravo");
    await harness.command("stash", "charlie");

    harness.ui.selectResponses.push((_title, options) => options[1]);
    harness.ui.selectResponses.push((_title, options) => {
      assert.deepEqual(options, ["Restore to editor", "Peek full text", "Enter order mode", "Delete", "← Back"]);
      return "Enter order mode";
    });
    harness.ui.customInputs.push([
      "\x1b[B", // move grabbed bravo below charlie: alpha, charlie, bravo
      "\r",     // release bravo
      "\x1b[A", // navigate to charlie
      "\r",     // grab charlie
      "\x1b[A", // move charlie above alpha
      "\x1b",   // finish
    ]);

    await harness.command("magazine");
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.load(identity)?.state.queue.map((entry) => entry.text), ["charlie", "alpha", "bravo"]);
    storage.close();
    const rendered = harness.ui.customRenders[0].flat().join("\n");
    assert.match(rendered, /Magazine order/);
    assert.match(rendered, /▸ #2 bravo/);
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("interactive-looking input outside TUI mode passes through", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "print-input", file: join(f.dir, "print.jsonl"), cwd: f.dir, branch: [], mode: "print" };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    const [result] = await harness.emit("input", { type: "input", source: "interactive", text: "do not capture;;" });
    assert.deepEqual(result, { action: "continue" });
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.load({ sessionId: session.id, sessionFile: session.file, cwd: session.cwd })?.state.queue, []);
    storage.close();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("--no-session magazines stay off disk and survive process-local reload", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "ephemeral", cwd: f.dir, branch: [], persisted: false };
    const first = makeHarness(session, f.databasePath);
    await first.emit("session_start", { type: "session_start", reason: "startup" });
    await first.command("stash", "memory only");
    assert.equal(existsSync(f.databasePath), false);
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });

    const reloaded = makeHarness(session, f.databasePath);
    await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
    assert.match(widgetText(reloaded), /memory only/);
    assert.equal(existsSync(f.databasePath), false);
    await reloaded.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("CLI startup forks inherit from the parent session header", async () => {
  const f = fixture();
  try {
    const parent: FakeSession = { id: "cli-parent", file: join(f.dir, "parent.jsonl"), cwd: f.dir, branch: [] };
    const parentHarness = makeHarness(parent, f.databasePath);
    await parentHarness.emit("session_start", { type: "session_start", reason: "startup" });
    await parentHarness.command("stash", "from CLI parent");
    await parentHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const child: FakeSession = {
      id: "cli-child",
      file: join(f.dir, "child.jsonl"),
      cwd: f.dir,
      branch: [],
      parentSession: parent.file,
    };
    const childHarness = makeHarness(child, f.databasePath);
    await childHarness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.match(widgetText(childHarness), /from CLI parent/);
    await childHarness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("notification failure cannot leak a stash-intent prompt to the model", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "notify-throw", file: join(f.dir, "notify.jsonl"), cwd: f.dir, branch: [] };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    (harness.ctx.ui as any).notify = () => { throw new Error("stale UI"); };
    const [result] = await harness.emit("input", { type: "input", source: "interactive", text: "still safe;;" });
    assert.deepEqual(result, { action: "handled" });
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.load({ sessionId: session.id, sessionFile: session.file, cwd: session.cwd })?.state.queue.map((entry) => entry.text), ["still safe"]);
    storage.close();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("restore rolls back when the editor handoff throws", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "restore-throw", file: join(f.dir, "restore.jsonl"), cwd: f.dir, branch: [] };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("stash", "must remain durable");
    (harness.ctx.ui as any).setEditorText = () => { throw new Error("editor unavailable"); };
    await harness.command("magazine", "1");
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.load({ sessionId: session.id, sessionFile: session.file, cwd: session.cwd })?.state.queue.map((entry) => entry.text), ["must remain durable"]);
    storage.close();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("clear confirmation refuses to delete drafts added while the dialog is open", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "clear-race", file: join(f.dir, "clear.jsonl"), cwd: f.dir, branch: [] };
    const identity = { sessionId: session.id, sessionFile: session.file, cwd: session.cwd };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("stash", "visible before confirm");
    (harness.ctx.ui as any).confirm = async () => {
      const concurrent = new MagazineStorage(f.databasePath);
      concurrent.mutate(identity, (current) => {
        const result = pushStash(current, "added during confirm");
        return { state: result.state, value: undefined, changed: true };
      });
      concurrent.close();
      return true;
    };
    await harness.command("magazine-clear");
    const storage = new MagazineStorage(f.databasePath);
    assert.deepEqual(storage.load(identity)?.state.queue.map((entry) => entry.text), ["visible before confirm", "added during confirm"]);
    storage.close();
    assert.ok(harness.ui.notifications.some(({ message }) => message.includes("changed while confirmation")));
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("revision polling refreshes a second live view after another connection commits", async () => {
  const f = fixture();
  try {
    const session: FakeSession = {
      id: "shared-view",
      file: join(f.dir, "shared.jsonl"),
      cwd: f.dir,
      branch: [],
    };
    const first = makeHarness(session, f.databasePath, 20);
    const second = makeHarness(session, f.databasePath, 20);
    await first.emit("session_start", { type: "session_start", reason: "startup" });
    await second.emit("session_start", { type: "session_start", reason: "startup" });
    await first.command("stash", "cross-process refresh");
    await waitFor(() => widgetText(second).includes("cross-process refresh"));
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await second.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("/magazine-recover transfers a selected orphan into the current empty session", async () => {
  const f = fixture();
  try {
    const orphanIdentity = {
      sessionId: "orphan",
      sessionFile: join(f.dir, "missing.jsonl"),
      cwd: f.dir,
    };
    const storage = new MagazineStorage(f.databasePath);
    storage.loadOrCreate(orphanIdentity);
    storage.mutate(orphanIdentity, (current) => {
      const result = pushStash(current, "orphaned draft");
      return { state: result.state, value: undefined, changed: true };
    });
    storage.close();

    const target: FakeSession = {
      id: "target",
      file: join(f.dir, "target.jsonl"),
      cwd: f.dir,
      branch: [],
    };
    const harness = makeHarness(target, f.databasePath);
    harness.ui.selectResponses.push((_title, options) => options[0]);
    harness.ui.confirmResponses.push(true);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("magazine-recover");
    assert.match(widgetText(harness), /orphaned draft/);
    assert.ok(harness.ui.notifications.some(({ message }) => message.includes("Recovered 1")));
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const verify = new MagazineStorage(f.databasePath);
    assert.deepEqual(verify.load(orphanIdentity)?.state.queue, []);
    assert.deepEqual(verify.load({ sessionId: target.id, sessionFile: target.file, cwd: target.cwd })?.state.queue.map((entry) => entry.text), ["orphaned draft"]);
    verify.close();
  } finally {
    f.cleanup();
  }
});

test("a write-time storage failure is handled and restores the original prompt", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "write-failure", file: join(f.dir, "write.jsonl"), cwd: f.dir, branch: [] };
    const identity = { sessionId: session.id, sessionFile: session.file, cwd: session.cwd };
    const harness = makeHarness(session, f.databasePath);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    const raw = new Database(f.databasePath);
    raw.prepare("UPDATE magazines SET queue_json = ? WHERE cwd = ? AND session_id = ?")
      .run("{broken", session.cwd, session.id);
    raw.close();

    const [result] = await harness.emit("input", {
      type: "input",
      source: "interactive",
      text: "restore after failed write;;",
    });
    assert.deepEqual(result, { action: "handled" });
    assert.equal(harness.ui.editorText, "restore after failed write;;");
    assert.ok(harness.ui.notifications.some(({ level }) => level === "error"));
    const corrupt = new MagazineStorage(f.databasePath);
    assert.throws(() => corrupt.load(identity));
    corrupt.close();
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("recovery cancels if the selected source changes during confirmation", async () => {
  const f = fixture();
  try {
    const orphan = { sessionId: "changing-orphan", sessionFile: join(f.dir, "missing.jsonl"), cwd: f.dir };
    const seed = new MagazineStorage(f.databasePath);
    seed.loadOrCreate(orphan);
    seed.mutate(orphan, (current) => {
      const result = pushStash(current, "first orphan draft");
      return { state: result.state, value: undefined, changed: true };
    });
    seed.close();

    const target: FakeSession = { id: "recovery-race-target", file: join(f.dir, "target.jsonl"), cwd: f.dir, branch: [] };
    const targetIdentity = { sessionId: target.id, sessionFile: target.file, cwd: target.cwd };
    const harness = makeHarness(target, f.databasePath);
    harness.ui.selectResponses.push((_title, options) => options[0]);
    (harness.ctx.ui as any).confirm = async () => {
      const concurrent = new MagazineStorage(f.databasePath);
      concurrent.mutate(orphan, (current) => {
        const result = pushStash(current, "changed during confirm");
        return { state: result.state, value: undefined, changed: true };
      });
      concurrent.close();
      return true;
    };
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("magazine-recover");
    const verify = new MagazineStorage(f.databasePath);
    assert.deepEqual(verify.load(targetIdentity)?.state.queue, []);
    assert.deepEqual(verify.load(orphan)?.state.queue.map((entry) => entry.text), ["first orphan draft", "changed during confirm"]);
    verify.close();
    assert.ok(harness.ui.notifications.some(({ message }) => message.includes("source magazine changed")));
    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});

test("revision polling self-defuses after a stale UI throws", async () => {
  const f = fixture();
  try {
    const session: FakeSession = { id: "stale-poll", file: join(f.dir, "poll.jsonl"), cwd: f.dir, branch: [] };
    const first = makeHarness(session, f.databasePath, 20);
    const stale = makeHarness(session, f.databasePath, 20);
    await first.emit("session_start", { type: "session_start", reason: "startup" });
    await stale.emit("session_start", { type: "session_start", reason: "startup" });
    let staleWidgetCalls = 0;
    (stale.ctx.ui as any).setWidget = () => {
      staleWidgetCalls += 1;
      throw new Error("stale context");
    };

    await first.command("stash", "first update");
    await waitFor(() => staleWidgetCalls === 1);
    await first.command("stash", "second update");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(staleWidgetCalls, 1);
    await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    await stale.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } finally {
    f.cleanup();
  }
});
