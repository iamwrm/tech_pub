import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin skills keep disable-model-invocation and export / annotate / last names", async () => {
  const last = await readFile(join(root, "skills/nvim-last/SKILL.md"), "utf8");
  const annotate = await readFile(join(root, "skills/nvim-annotate/SKILL.md"), "utf8");
  const imported = await readFile(join(root, "skills/nvim-import/SKILL.md"), "utf8");
  for (const text of [last, annotate, imported]) {
    assert.match(text, /disable-model-invocation:\s*true/);
    assert.match(text, /Do not send a commentary\/status message/);
    assert.match(text, /!`/);
    assert.match(text, /Read the absolute annotation path|Read that\s+file/);
  }
  assert.match(last, /nvimotator" export/);
  assert.match(annotate, /nvimotator" annotate/);
  assert.match(imported, /nvimotator" last/);
  assert.doesNotMatch(last, /blocks until Neovim/);
  const plugin = JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8")) as {
    name: string;
    commands?: string[];
    skills?: string[];
  };
  assert.equal(plugin.name, "nvimotator");
  assert.deepEqual(plugin.commands, ["./commands"]);
  assert.deepEqual(plugin.skills, ["./skills"]);
  const lastCommand = await readFile(join(root, "commands/nvim-last.md"), "utf8");
  const annotateCommand = await readFile(join(root, "commands/nvim-annotate.md"), "utf8");
  const importCommand = await readFile(join(root, "commands/nvim-import.md"), "utf8");
  assert.equal(lastCommand, last);
  assert.equal(annotateCommand, annotate);
  assert.equal(importCommand, imported);
  const pkg = JSON.parse(await readFile(join(root, "../package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    pi?: { extensions?: string[] };
  };
  assert.equal(pkg.dependencies?.["@plannotator/pi-extension"], undefined);
  assert.deepEqual(pkg.pi?.extensions, ["index.ts"]);
  await assert.rejects(readFile(join(root, "package.json")), /ENOENT/);
});
