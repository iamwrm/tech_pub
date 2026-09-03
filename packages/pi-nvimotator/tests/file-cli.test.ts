import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { snapshotFromAssistantText } from "../src/assistant-message.ts";
import { CliExitError, runFileStoreCli, type CliIo } from "../src/file-cli.ts";
import { FileStore } from "../src/file-store.ts";
import { markSlotSent } from "./sent-slot.ts";

function collectingIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: { write(chunk: string) { stdout.push(String(chunk)); } },
    stderr: { write(chunk: string) { stderr.push(String(chunk)); } },
  };
  return {
    io,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function withStore<T>(fn: (store: FileStore, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nvimotator-cli-"));
  await chmod(root, 0o700);
  const previous = process.env.NVIMOTATOR_STORE;
  process.env.NVIMOTATOR_STORE = root;
  try {
    return await fn(new FileStore(root), root);
  } finally {
    if (previous === undefined) delete process.env.NVIMOTATOR_STORE;
    else process.env.NVIMOTATOR_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const host = {
  name: "nvimotator",
  version: "0.4.0",
  exportSnapshot: () => snapshotFromAssistantText("session", "msg_new", "Latest rendered\nsecond line"),
};

test("file-cli help and version write to stdout", async () => {
  const help = collectingIo();
  await runFileStoreCli(["node", "nvimotator", "--help"], help.io, host);
  assert.match(help.stdout(), /nvimotator export/);
  assert.match(help.stdout(), /nvimotator last/);
  assert.doesNotMatch(help.stdout(), /nvimotator complete/);
  const version = collectingIo();
  await runFileStoreCli(["node", "nvimotator", "--version"], version.io, host);
  assert.match(version.stdout(), /0\.4\.0/);
});

test("export prints an absolute snapshot path and a stderr locator, then exits", async () => {
  await withStore(async (store) => {
    const collected = collectingIo();
    await runFileStoreCli(["node", "nvimotator", "export"], collected.io, { ...host, store });
    const stdout = collected.stdout().trim();
    assert.equal(stdout, join(store.root, "1", "snapshot.md"));
    assert.match(collected.stderr(), /Nvimotator 1/);
    assert.match(collected.stderr(), /nvim -c 'NvimotatorAttach 1'/);
    assert.doesNotMatch(collected.stdout(), /Nvimotator 1|last assistant message|# Message Feedback/);
    const text = await readFile(stdout, "utf8");
    assert.match(text, /Latest rendered/);
  });
});

test("annotate prints a snapshot path and last/import print the annotation path after Send", async () => {
  await withStore(async (store, root) => {
    const notes = join(root, "notes.md");
    await writeFile(notes, "# Notes\nHello\n");
    await chmod(notes, 0o600);
    const exported = collectingIo();
    await runFileStoreCli(["node", "nvimotator", "annotate", notes], exported.io, { ...host, store });
    const snapshotPath = exported.stdout().trim();
    assert.equal(snapshotPath, join(store.root, "1", "snapshot.md"));
    assert.match(exported.stderr(), /File: /);
    const sent = await markSlotSent(store, 1, "Neovim Send body");
    const last = collectingIo();
    await runFileStoreCli(["node", "nvimotator", "last"], last.io, { ...host, store });
    assert.equal(last.stdout().trim(), join(store.root, "last", "annotation.md"));
    assert.equal(last.stderr(), "");
    const imported = collectingIo();
    await runFileStoreCli(["node", "nvimotator", "import", "1"], imported.io, { ...host, store });
    assert.equal(imported.stdout().trim(), sent.annotationPath);
  });
});

test("CLI rejects secrets and unknown commands without writing stdout paths", async () => {
  await withStore(async (store, root) => {
    const envPath = join(root, ".env");
    await writeFile(envPath, "SECRET=1\n");
    const collected = collectingIo();
    await assert.rejects(
      () => runFileStoreCli(["node", "nvimotator", "annotate", envPath], collected.io, { ...host, store }),
      (error: unknown) => error instanceof CliExitError && error.exitCode === 1,
    );
    assert.match(collected.stderr(), /secrets/);
    assert.equal(collected.stdout(), "");
    const unknown = collectingIo();
    await assert.rejects(
      () => runFileStoreCli(["node", "nvimotator", "last-message"], unknown.io, { ...host, store }),
      CliExitError,
    );
    const complete = collectingIo();
    await assert.rejects(
      () => runFileStoreCli(["node", "nvimotator", "complete", "1"], complete.io, { ...host, store }),
      CliExitError,
    );
    assert.match(complete.stderr(), /Unknown command: complete/);
    assert.equal(complete.stdout(), "");
  });
});
