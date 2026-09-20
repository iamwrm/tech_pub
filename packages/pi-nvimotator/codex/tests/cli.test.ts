import { collectingIo, withStoreRoot as withStore } from "../../tests/cli-helpers.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileStore } from "../../src/file-store.ts";
import { CliExitError, runNvimotatorCli } from "../src/cli.ts";
import { markSlotSent } from "../../tests/sent-slot.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(packageRoot, "tests/fixtures");
const liveLog = join(fixtures, "rollout-live.jsonl");
const notes = join(fixtures, "notes.md");


test("CLI help and version write to stdout", async () => {
  const help = collectingIo();
  await runNvimotatorCli(["node", "nvimotator", "--help"], help.io);
  assert.match(help.stdout(), /nvimotator export/);
  assert.doesNotMatch(help.stdout(), /nvimotator complete/);
  const version = collectingIo();
  await runNvimotatorCli(["node", "nvimotator", "--version"], version.io);
  assert.match(version.stdout(), /0\.1\.0/);
});

test("CLI export --log writes a snapshot and prints its absolute path", async () => {
  await withStore(async (storeRoot) => {
    const collected = collectingIo();
    await runNvimotatorCli(["node", "nvimotator", "export", "--log", liveLog], collected.io);
    const path = collected.stdout().trim();
    assert.equal(path, join(storeRoot, "1", "snapshot.md"));
    assert.match(collected.stderr(), /Nvimotator 1/);
    assert.doesNotMatch(collected.stdout(), /last assistant message|# Message Feedback/);
    const text = await readFile(path, "utf8");
    assert.match(text, /Latest rendered/);
  });
});

test("CLI annotate of a markdown file prints a snapshot path", async () => {
  await withStore(async (storeRoot) => {
    const collected = collectingIo();
    await runNvimotatorCli(["node", "nvimotator", "annotate", notes], collected.io);
    assert.equal(collected.stdout().trim(), join(storeRoot, "1", "snapshot.md"));
    assert.match(collected.stderr(), /File: /);
  });
});

test("CLI last after a sent slot prints the stable annotation path", async () => {
  await withStore(async (storeRoot) => {
    await runNvimotatorCli(["node", "nvimotator", "export", "--log", liveLog], collectingIo().io);
    await markSlotSent(new FileStore(storeRoot), 1, "From Codex");
    const last = collectingIo();
    await runNvimotatorCli(["node", "nvimotator", "last"], last.io);
    assert.equal(last.stdout().trim(), join(storeRoot, "last", "annotation.md"));
    const body = await readFile(last.stdout().trim(), "utf8");
    assert.match(body, /From Codex/);
  });
});

test("CLI export --log without a path exits 1", async () => {
  const collected = collectingIo();
  await assert.rejects(
    () => runNvimotatorCli(["node", "nvimotator", "export", "--log"], collected.io),
    (error: unknown) => error instanceof CliExitError && error.exitCode === 1,
  );
  assert.equal(collected.stdout(), "");
});
