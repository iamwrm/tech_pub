import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("skills name nvim-last / nvim-annotate / nvim-import and keep a binary placeholder", async () => {
  const last = await readFile(join(root, "skills/nvim-last/SKILL.md"), "utf8");
  const annotate = await readFile(join(root, "skills/nvim-annotate/SKILL.md"), "utf8");
  const imported = await readFile(join(root, "skills/nvim-import/SKILL.md"), "utf8");
  for (const text of [last, annotate, imported]) {
    assert.match(text, /disable-model-invocation:\s*true/);
    assert.match(text, /Do not send a commentary\/status message/);
    assert.match(text, /__NVIMOTATOR_BIN__/);
    assert.doesNotMatch(text, /hooks\.json/);
    assert.doesNotMatch(text, /blocks until Neovim/);
  }
  assert.match(last, /name:\s*nvim-last/);
  assert.match(last, /__NVIMOTATOR_BIN__ export/);
  assert.match(annotate, /name:\s*nvim-annotate/);
  assert.match(imported, /name:\s*nvim-import/);
  const pkg = JSON.parse(await readFile(join(root, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    pi?: { extensions?: string[] };
  };
  assert.equal(pkg.dependencies?.["@plannotator/pi-extension"], undefined);
  assert.deepEqual(pkg.pi?.extensions, ["index.ts"]);
  await assert.rejects(readFile(join(root, "package.json")), /ENOENT/);
});

test("install-skills.sh writes absolute paths and does not create hooks.json", async () => {
  const dest = await mkdtemp(join(tmpdir(), "codex-nvimotator-skills-"));
  try {
    const result = spawnSync("bash", [join(root, "scripts/install-skills.sh")], {
      cwd: root,
      env: { ...process.env, NVIMOTATOR_SKILLS_DIR: dest },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const last = await readFile(join(dest, "nvim-last/SKILL.md"), "utf8");
    const annotate = await readFile(join(dest, "nvim-annotate/SKILL.md"), "utf8");
    const imported = await readFile(join(dest, "nvim-import/SKILL.md"), "utf8");
    const bin = join(root, "bin/nvimotator");
    assert.ok(last.includes(bin), "installed last skill contains absolute bin path");
    assert.ok(annotate.includes(bin), "installed annotate skill contains absolute bin path");
    assert.ok(imported.includes(bin), "installed import skill contains absolute bin path");
    assert.doesNotMatch(last, /__NVIMOTATOR_BIN__/);
    assert.match(last, /\$nvim-last|nvim-last/);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dest);
    assert.ok(!names.includes("hooks.json"));
    assert.match(result.stdout, /No hooks\.json was written/);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});
