import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyAnnotateFileName, resolveAnnotateFilePath } from "../../src/file-snapshot.ts";
import { CliExitError, runNvimotatorCli, type CliIo } from "../src/cli.ts";
import { projectSlugFromCwd } from "../src/claude-session.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(packageRoot, "tests/fixtures");
const liveLog = join(fixtures, "transcript-live.jsonl");
const notes = join(fixtures, "notes.md");

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

async function withStore<T>(fn: (storeRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "claude-nvimotator-cli-"));
  await chmod(root, 0o700);
  const previous = process.env.NVIMOTATOR_STORE;
  process.env.NVIMOTATOR_STORE = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.NVIMOTATOR_STORE;
    else process.env.NVIMOTATOR_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("CLI help and version write to stdout", async () => {
  const help = collectingIo();
  await runNvimotatorCli(["node", "nvimotator", "--help"], help.io);
  assert.match(help.stdout(), /nvimotator export/);
  assert.doesNotMatch(help.stdout(), /nvimotator complete/);
  const version = collectingIo();
  await runNvimotatorCli(["node", "nvimotator", "--version"], version.io);
  assert.match(version.stdout(), /0\.2\.0/);
});

test("CLI export --log without a path exits 1", async () => {
  const collected = collectingIo();
  await assert.rejects(
    () => runNvimotatorCli(["node", "nvimotator", "export", "--log"], collected.io),
    (error: unknown) => error instanceof CliExitError && error.exitCode === 1,
  );
  assert.match(collected.stderr(), /Usage: nvimotator export/);
  assert.equal(collected.stdout(), "");
});

test("CLI export --log writes a snapshot and prints its absolute path", async () => {
  await withStore(async (storeRoot) => {
    const collected = collectingIo();
    await runNvimotatorCli(["node", "nvimotator", "export", "--log", liveLog], collected.io);
    const path = collected.stdout().trim();
    assert.equal(path, join(storeRoot, "1", "snapshot.md"));
    assert.match(collected.stderr(), /Nvimotator 1/);
    assert.match(collected.stderr(), /nvim -c 'NvimotatorAttach 1'/);
    assert.doesNotMatch(collected.stdout(), /last assistant message|# Message Feedback/);
    const text = await readFile(path, "utf8");
    assert.match(text, /Latest rendered/);
  });
});

test("CLI annotate rejects secrets and unsupported types using the shared allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-nvimotator-allow-"));
  try {
    assert.equal(classifyAnnotateFileName("notes.md"), "document");
    assert.equal(classifyAnnotateFileName("bridge.ts"), "source");
    assert.equal(classifyAnnotateFileName(".env"), "secret");
    const envPath = join(root, ".env");
    await writeFile(envPath, "SECRET=1\n");
    await assert.rejects(resolveAnnotateFilePath(envPath, root), /secrets/);
    const png = join(root, "photo.png");
    await writeFile(png, "not a png");
    await assert.rejects(resolveAnnotateFilePath(png, root), /Unsupported file type/);
    const collected = collectingIo();
    await assert.rejects(
      () => runNvimotatorCli(["node", "nvimotator", "annotate", envPath], collected.io),
      (error: unknown) => error instanceof CliExitError || (error instanceof Error && /secrets/.test(error.message)),
    );
    assert.match(collected.stderr(), /secrets/);
    assert.equal(collected.stdout(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI annotate of a markdown file prints a snapshot path and stays file-shaped", async () => {
  await withStore(async (storeRoot) => {
    const collected = collectingIo();
    await runNvimotatorCli(["node", "nvimotator", "annotate", notes], collected.io);
    assert.equal(collected.stdout().trim(), join(storeRoot, "1", "snapshot.md"));
    assert.match(collected.stderr(), /File: /);
    const stored = JSON.parse(await readFile(join(storeRoot, "1", "snapshot.json"), "utf8")) as { kind?: string };
    assert.equal(stored.kind, "file");
  });
});

test("CLI export without --log discovers the transcript via CLAUDE_CONFIG_DIR", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-nvimotator-discover-"));
  const cwd = join(root, "work");
  const previousCwd = process.cwd();
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID;
  const previousStore = process.env.NVIMOTATOR_STORE;
  try {
    await mkdir(cwd, { recursive: true });
    const slug = projectSlugFromCwd(cwd);
    const projectDir = join(root, "projects", slug);
    await mkdir(projectDir, { recursive: true });
    await copyFile(liveLog, join(projectDir, "sess-live.jsonl"));
    const storeRoot = join(root, "store");
    await mkdir(storeRoot, { recursive: true, mode: 0o700 });
    await chmod(storeRoot, 0o700);
    process.env.NVIMOTATOR_STORE = storeRoot;
    process.env.CLAUDE_CONFIG_DIR = root;
    process.env.CLAUDE_CODE_SESSION_ID = "sess-live";
    process.chdir(cwd);
    const collected = collectingIo();
    await runNvimotatorCli(["node", "nvimotator", "export"], collected.io);
    const path = collected.stdout().trim();
    assert.equal(path, join(storeRoot, "1", "snapshot.md"));
    const text = await readFile(path, "utf8");
    assert.match(text, /Latest rendered/);
  } finally {
    process.chdir(previousCwd);
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession;
    if (previousStore === undefined) delete process.env.NVIMOTATOR_STORE;
    else process.env.NVIMOTATOR_STORE = previousStore;
    await rm(root, { recursive: true, force: true });
  }
});
