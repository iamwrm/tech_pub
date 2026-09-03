import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const liveLog = join(packageRoot, "tests/fixtures/transcript-live.jsonl");
const bundled = join(packageRoot, "cli.bundle.js");

test("bundled CLI export --log prints a snapshot path and exits without blocking", async () => {
  const source = await readFile(bundled, "utf8");
  assert.doesNotMatch(source, /@plannotator\/pi-extension/);
  assert.doesNotMatch(source, /runBlockingBridge/);
  const store = await mkdtemp(join(tmpdir(), "claude-nvimotator-bundle-"));
  await chmod(store, 0o700);
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NVIMOTATOR_STORE: store };
    delete env.NODE_TEST_CONTEXT;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bundled, "export", "--log", liveLog], {
        cwd: packageRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(store, "1", "snapshot.md"));
    assert.match(result.stderr, /Nvimotator 1/);
    assert.doesNotMatch(result.stdout, /last assistant message|# Message Feedback/);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
