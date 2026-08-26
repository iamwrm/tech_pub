import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { hashTree, validateGeneratedPackage } from "../scripts/lib.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(packageRoot, "UPSTREAM.lock.json"), "utf8"));

test("Pi discovers exactly the locked generated inventory", () => {
  const result = loadSkillsFromDir({ dir: join(packageRoot, "skills"), source: "test" });
  assert.deepEqual(
    result.skills.map((skill) => skill.name).sort(),
    lock.includedSkills,
  );
  assert.deepEqual(result.diagnostics, []);
});

test("Pi package filtering disables the complete collection atomically", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-poteto-package-"));
  const settingsPath = join(agentDir, "settings.json");
  try {
    writeFileSync(settingsPath, JSON.stringify({ packages: [packageRoot] }));
    const loader = new DefaultResourceLoader({ cwd: packageRoot, agentDir, noContextFiles: true });
    await loader.reload();
    const enabledNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
    assert.deepEqual(lock.includedSkills.filter((name) => enabledNames.has(name)), lock.includedSkills);

    writeFileSync(settingsPath, JSON.stringify({ packages: [{ source: packageRoot, skills: [] }] }));
    await loader.reload();
    const disabledNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
    assert.deepEqual(lock.includedSkills.filter((name) => disabledNames.has(name)), []);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("generated tree validates and matches its lock hash", () => {
  const result = validateGeneratedPackage(packageRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(hashTree(join(packageRoot, "skills")), lock.generatedTreeHash);
});

test("dry-run filtering is atomic and does not change committed output", () => {
  const before = hashTree(join(packageRoot, "skills"));
  const output = execFileSync(
    process.execPath,
    [
      "scripts/sync-upstream.mjs",
      "--source",
      "vendor/pstack",
      "--ref",
      lock.commit,
      "--exclude-skill",
      "bro",
      "--dry-run",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const report = JSON.parse(output);
  assert.equal(report.included, lock.includedSkills.length - 1);
  assert(!report.includedSkills.includes("bro"));
  assert.equal(hashTree(join(packageRoot, "skills")), before);
});

test("selection flags require preview or persisted policy", () => {
  const result = spawnSync(process.execPath, ["scripts/sync-upstream.mjs", "--exclude-skill", "bro"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--dry-run or --save-policy/);
});

test("capability exclusions win over an explicit skill include", () => {
  const output = execFileSync(
    process.execPath,
    [
      "scripts/sync-upstream.mjs",
      "--source",
      "vendor/pstack",
      "--ref",
      lock.commit,
      "--include-skill",
      "swarm",
      "--exclude-capability",
      "cursor-cloud-agent",
      "--dry-run",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const report = JSON.parse(output);
  assert(!report.includedSkills.includes("swarm"));
});

test("filtering a required dependency fails closed", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/sync-upstream.mjs",
      "--source",
      "vendor/pstack",
      "--ref",
      lock.commit,
      "--exclude-skill",
      "principle-prove-it-works",
      "--dry-run",
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /poteto-mode: required skill principle-prove-it-works is filtered out/);
});

test("saved filtering updates policy, generated output, and lock together", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-poteto-save-policy-"));
  const fixtureRoot = join(tempRoot, "package");
  try {
    for (const path of [
      "compat",
      "scripts",
      "skills",
      "vendor",
      "sync-policy.json",
      "UPSTREAM.lock.json",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      cpSync(join(packageRoot, path), join(fixtureRoot, path), { recursive: true });
    }
    execFileSync(
      process.execPath,
      [
        "scripts/sync-upstream.mjs",
        "--source",
        "vendor/pstack",
        "--ref",
        lock.commit,
        "--exclude-skill",
        "bro",
        "--save-policy",
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    const savedPolicy = JSON.parse(readFileSync(join(fixtureRoot, "sync-policy.json"), "utf8"));
    const savedLock = JSON.parse(readFileSync(join(fixtureRoot, "UPSTREAM.lock.json"), "utf8"));
    assert(savedPolicy.excludeSkills.includes("bro"));
    assert(!savedLock.includedSkills.includes("bro"));
    assert(savedLock.excludedSkills.includes("bro"));
    assert(!savedLock.excludedSkills.includes("poteto-mode"));
    assert(!existsSync(join(fixtureRoot, "skills", "bro")));
    assert(!readFileSync(join(fixtureRoot, "skills", "poteto-mode", "SKILL.md"), "utf8").includes("Cursor cloud"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
