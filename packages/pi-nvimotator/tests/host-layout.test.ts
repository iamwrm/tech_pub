import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "../..");

test("Claude and Codex hosts are nested folders without their own package.json", async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    files?: string[];
    pi?: { extensions?: string[] };
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.pi?.extensions, ["index.ts"]);
  assert.ok(pkg.files?.includes("index.ts"));
  assert.ok(pkg.files?.includes("claude"));
  assert.ok(pkg.files?.includes("codex"));
  assert.equal(pkg.dependencies?.["@plannotator/pi-extension"], undefined);
  await assert.rejects(readFile(join(packageRoot, "claude/package.json")), /ENOENT/);
  await assert.rejects(readFile(join(packageRoot, "codex/package.json")), /ENOENT/);
  await assert.rejects(readFile(join(repoRoot, "packages/claude-nvimotator/package.json")), /ENOENT/);
  await assert.rejects(readFile(join(repoRoot, "packages/codex-nvimotator/package.json")), /ENOENT/);
});

test("marketplace copies only the Claude host folder", async () => {
  const marketplace = JSON.parse(await readFile(join(repoRoot, ".claude-plugin/marketplace.json"), "utf8")) as {
    plugins: Array<{ name: string; source: string }>;
  };
  assert.equal(marketplace.plugins[0]?.name, "nvimotator");
  assert.equal(marketplace.plugins[0]?.source, "./packages/pi-nvimotator/claude");
});
