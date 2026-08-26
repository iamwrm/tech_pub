#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidGeneratedPackage,
  hashFile,
  hashTree,
  listFiles,
  readJson,
  validateProvenance,
} from "./lib.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(packageRoot, "sync-policy.json");
const lockPath = join(packageRoot, "UPSTREAM.lock.json");
const capabilitiesPath = join(packageRoot, "compat", "capabilities.json");
const overridesRoot = join(packageRoot, "compat", "overrides");
const overridesLockPath = join(packageRoot, "compat", "overrides-lock.json");
const currentVendorRoot = join(packageRoot, "vendor", "pstack");
const currentSkillsRoot = join(packageRoot, "skills");

function usage() {
  console.log(`Usage: node scripts/sync-upstream.mjs [options]

Options:
  --ref <commit-or-tag>              Upstream ref; defaults to UPSTREAM.lock.json
  --source <checkout-or-pstack-dir>  Use a local clean checkout instead of fetching
  --exclude-skill <name>             Exclude one skill (repeatable)
  --include-skill <name>             Add one skill to the profile (repeatable)
  --exclude-capability <name>        Exclude tagged skills (repeatable)
  --save-policy                      Persist selection flags to sync-policy.json
  --dry-run                          Stage and report without changing files
  --check                            Rebuild from vendor/pstack and verify determinism
  --help                             Show this help

Selection flags require --dry-run or --save-policy.`);
}

function parseArgs(argv) {
  const options = {
    excludes: [],
    includes: [],
    capabilities: [],
    dryRun: false,
    check: false,
    savePolicy: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--ref") options.ref = take();
    else if (arg === "--source") options.source = take();
    else if (arg === "--exclude-skill") options.excludes.push(take());
    else if (arg === "--include-skill") options.includes.push(take());
    else if (arg === "--exclude-capability") options.capabilities.push(take());
    else if (arg === "--save-policy") options.savePolicy = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.check && (options.source || options.ref || options.savePolicy)) {
    throw new Error("--check uses the committed vendor snapshot and cannot fetch or save policy");
  }
  const hasSelectionFlags = options.excludes.length + options.includes.length + options.capabilities.length > 0;
  if (hasSelectionFlags && !options.dryRun && !options.savePolicy) {
    throw new Error("selection flags require --dry-run or --save-policy so committed output stays reproducible");
  }
  return options;
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function resolveLocalPstack(source, ref) {
  const absolute = resolve(source);
  const pstackRoot = existsSync(join(absolute, "pstack", ".cursor-plugin", "plugin.json"))
    ? join(absolute, "pstack")
    : absolute;
  if (!existsSync(join(pstackRoot, ".cursor-plugin", "plugin.json"))) {
    throw new Error(`local source does not contain a pstack subtree: ${absolute}`);
  }
  if (resolve(pstackRoot) === resolve(currentVendorRoot)) {
    if (!ref) throw new Error("the vendored snapshot requires --ref");
    return { pstackRoot, commit: ref };
  }

  let commit = ref;
  try {
    const repoRoot = run("git", ["rev-parse", "--show-toplevel"], pstackRoot);
    const resolvedRef = run("git", ["rev-parse", `${ref}^{commit}`], repoRoot);
    const head = run("git", ["rev-parse", "HEAD"], repoRoot);
    if (head !== resolvedRef) throw new Error(`local checkout HEAD ${head} does not match requested ref ${resolvedRef}`);
    const relativePstack = pstackRoot.slice(repoRoot.length + 1).replaceAll("\\", "/") || ".";
    const dirty = run("git", ["status", "--porcelain", "--", relativePstack], repoRoot);
    if (dirty) throw new Error(`local pstack subtree has uncommitted changes:\n${dirty}`);
    commit = resolvedRef;
  } catch (error) {
    if (!String(error.message).includes("not a git repository")) throw error;
    if (!commit) throw new Error("a non-Git local source requires --ref");
  }
  return { pstackRoot, commit };
}

function fetchPstack(repository, ref, tempRoot) {
  const checkout = join(tempRoot, "checkout");
  run("git", ["init", checkout], packageRoot);
  run("git", ["-C", checkout, "remote", "add", "origin", repository], packageRoot);
  run("git", ["-C", checkout, "sparse-checkout", "init", "--cone"], packageRoot);
  run("git", ["-C", checkout, "sparse-checkout", "set", "pstack"], packageRoot);
  run("git", ["-C", checkout, "fetch", "--depth=1", "origin", ref], packageRoot);
  run("git", ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"], packageRoot);
  return { pstackRoot: join(checkout, "pstack"), commit: run("git", ["-C", checkout, "rev-parse", "HEAD"], packageRoot) };
}

function applySelectionFlags(policy, options) {
  const next = structuredClone(policy);
  const include = new Set(next.includeSkills ?? ["*"]);
  const exclude = new Set(next.excludeSkills ?? []);
  const capabilities = new Set(next.excludeCapabilities ?? []);
  for (const skill of options.includes) {
    include.add(skill);
    exclude.delete(skill);
  }
  for (const skill of options.excludes) exclude.add(skill);
  for (const capability of options.capabilities) capabilities.add(capability);
  next.includeSkills = [...include].sort();
  next.excludeSkills = [...exclude].sort();
  next.excludeCapabilities = [...capabilities].sort();
  return next;
}

function upstreamSkillNames(pstackRoot) {
  const skillsRoot = join(pstackRoot, "skills");
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

export function selectSkills(allSkills, policy, capabilities) {
  const known = new Set(allSkills);
  const include = new Set(policy.includeSkills ?? ["*"]);
  const exclude = new Set(policy.excludeSkills ?? []);
  const excludedCapabilities = new Set(policy.excludeCapabilities ?? []);

  for (const name of [...include, ...exclude]) {
    if (name !== "*" && !known.has(name)) throw new Error(`sync policy names unknown upstream skill: ${name}`);
  }

  const selected = allSkills.filter((name) => include.has("*") || include.has(name));
  const filtered = selected.filter((name) => {
    if (exclude.has(name)) return false;
    return !(capabilities[name] ?? []).some((capability) => excludedCapabilities.has(capability));
  });
  return {
    includedSkills: filtered.sort(),
    excludedSkills: allSkills.filter((name) => !filtered.includes(name)).sort(),
  };
}

function generateSkills(pstackRoot, destination, selection) {
  const overridesLock = readJson(overridesLockPath);
  for (const skill of selection.includedSkills) {
    const override = join(overridesRoot, skill);
    if (!existsSync(override)) {
      cpSync(join(pstackRoot, "skills", skill), join(destination, skill), { recursive: true });
      continue;
    }
    for (const overrideFile of listFiles(override)) {
      const relativeFile = `${skill}/${relative(override, overrideFile).replaceAll("\\", "/")}`;
      const expectedHash = overridesLock[relativeFile];
      if (!expectedHash) throw new Error(`compatibility override is not pinned: ${relativeFile}`);
      const upstreamFile = join(pstackRoot, "skills", relativeFile);
      if (!existsSync(upstreamFile)) throw new Error(`compatibility override source disappeared: ${relativeFile}`);
      const actualHash = hashFile(upstreamFile);
      if (actualHash !== expectedHash) {
        throw new Error(`compatibility override source changed: ${relativeFile}\nexpected ${expectedHash}\nactual   ${actualHash}`);
      }
    }
    cpSync(override, join(destination, skill), { recursive: true });
  }
}

function createLock(baseLock, policy, commit, pstackRoot, skillsRoot, selection) {
  const plugin = readJson(join(pstackRoot, ".cursor-plugin", "plugin.json"));
  return {
    schemaVersion: 1,
    repository: baseLock.repository,
    subtree: "pstack",
    commit,
    upstreamVersion: plugin.version,
    profile: policy.profile,
    includedSkills: selection.includedSkills,
    excludedSkills: selection.excludedSkills,
    excludedCapabilities: [...(policy.excludeCapabilities ?? [])].sort(),
    upstreamTreeHash: hashTree(pstackRoot),
    generatedTreeHash: hashTree(skillsRoot),
    patchsetHash: hashTree(join(packageRoot, "compat")),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replaceGeneratedTrees(stagedVendor, stagedSkills, nextLock, nextPolicy) {
  const vendorParent = dirname(currentVendorRoot);
  const backupVendor = join(vendorParent, ".pstack.backup");
  const backupSkills = join(packageRoot, ".skills.backup");
  const oldLock = existsSync(lockPath) ? readFileSync(lockPath) : null;
  const oldPolicy = existsSync(policyPath) ? readFileSync(policyPath) : null;
  mkdirSync(vendorParent, { recursive: true });
  rmSync(backupVendor, { recursive: true, force: true });
  rmSync(backupSkills, { recursive: true, force: true });

  let vendorBackedUp = false;
  let skillsBackedUp = false;
  try {
    if (existsSync(currentVendorRoot)) {
      renameSync(currentVendorRoot, backupVendor);
      vendorBackedUp = true;
    }
    if (existsSync(currentSkillsRoot)) {
      renameSync(currentSkillsRoot, backupSkills);
      skillsBackedUp = true;
    }
    renameSync(stagedVendor, currentVendorRoot);
    renameSync(stagedSkills, currentSkillsRoot);
    writeFileSync(`${lockPath}.tmp`, `${JSON.stringify(nextLock, null, 2)}\n`);
    renameSync(`${lockPath}.tmp`, lockPath);
    if (nextPolicy) {
      writeFileSync(`${policyPath}.tmp`, `${JSON.stringify(nextPolicy, null, 2)}\n`);
      renameSync(`${policyPath}.tmp`, policyPath);
    }
    rmSync(backupVendor, { recursive: true, force: true });
    rmSync(backupSkills, { recursive: true, force: true });
  } catch (error) {
    rmSync(currentVendorRoot, { recursive: true, force: true });
    rmSync(currentSkillsRoot, { recursive: true, force: true });
    if (vendorBackedUp && existsSync(backupVendor)) renameSync(backupVendor, currentVendorRoot);
    if (skillsBackedUp && existsSync(backupSkills)) renameSync(backupSkills, currentSkillsRoot);
    if (oldLock) writeFileSync(lockPath, oldLock);
    else rmSync(lockPath, { force: true });
    if (oldPolicy) writeFileSync(policyPath, oldPolicy);
    else rmSync(policyPath, { force: true });
    throw error;
  } finally {
    rmSync(`${lockPath}.tmp`, { force: true });
    rmSync(`${policyPath}.tmp`, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const baseLock = readJson(lockPath);
  const basePolicy = readJson(policyPath);
  const policy = applySelectionFlags(basePolicy, options);
  const capabilities = readJson(capabilitiesPath);
  const stageRoot = mkdtempSync(join(packageRoot, ".sync-stage-"));

  try {
    let source;
    if (options.check) source = { pstackRoot: currentVendorRoot, commit: baseLock.commit };
    else if (options.source) source = resolveLocalPstack(options.source, options.ref ?? baseLock.commit);
    else source = fetchPstack(baseLock.repository, options.ref ?? baseLock.commit, stageRoot);

    const stagedVendor = join(stageRoot, "vendor", "pstack");
    const stagedSkills = join(stageRoot, "skills");
    cpSync(source.pstackRoot, stagedVendor, { recursive: true });
    const allSkills = upstreamSkillNames(stagedVendor);
    const selection = selectSkills(allSkills, policy, capabilities);
    generateSkills(stagedVendor, stagedSkills, selection);
    const nextLock = createLock(baseLock, policy, source.commit, stagedVendor, stagedSkills, selection);
    assertValidGeneratedPackage(packageRoot, { skillsRoot: stagedSkills, skipLock: true });
    const provenanceErrors = validateProvenance(packageRoot, nextLock, stagedVendor);
    const attributionErrors = provenanceErrors.filter((error) => error.includes("THIRD_PARTY_NOTICES.md"));
    const blockingProvenanceErrors = provenanceErrors.filter((error) => !error.includes("THIRD_PARTY_NOTICES.md"));
    if (blockingProvenanceErrors.length > 0) throw new Error(blockingProvenanceErrors.join("\n"));
    if (!options.dryRun && attributionErrors.length > 0) throw new Error(attributionErrors.join("\n"));

    const report = {
      commit: nextLock.commit,
      upstreamVersion: nextLock.upstreamVersion,
      profile: policy.profile,
      included: selection.includedSkills.length,
      excluded: selection.excludedSkills.length,
      includedSkills: selection.includedSkills,
      excludedSkills: selection.excludedSkills,
      provenanceWarnings: attributionErrors,
      changed:
        !existsSync(currentVendorRoot) ||
        !existsSync(currentSkillsRoot) ||
        hashTree(currentVendorRoot) !== nextLock.upstreamTreeHash ||
        hashTree(currentSkillsRoot) !== nextLock.generatedTreeHash ||
        !sameJson(baseLock, nextLock) ||
        (options.savePolicy && !sameJson(basePolicy, policy)),
    };

    if (options.check) {
      if (report.changed) throw new Error(`generated state is stale:\n${JSON.stringify(report, null, 2)}`);
      assertValidGeneratedPackage(packageRoot);
      console.log(`sync check passed at ${nextLock.commit}; ${selection.includedSkills.length} skills`);
      return;
    }

    if (options.dryRun) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    replaceGeneratedTrees(stagedVendor, stagedSkills, nextLock, options.savePolicy ? policy : null);
    console.log(`synced pstack ${nextLock.upstreamVersion} at ${nextLock.commit}`);
    console.log(`included ${selection.includedSkills.length} skills; excluded ${selection.excludedSkills.length}`);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
