#!/usr/bin/env node
// Maintains packages/<name>/last_sync_info.json for every package in this repo.
// Reference shape (packages/pa-btw2/last_sync_info.json):
//   {
//     "upstream": "https://github.com/iamwrm/piagent-config/tree/main/packages/<src>",
//     "lastSync": "<ISO-8601 UTC, seconds precision>"
//   }
//
// Usage:
//   node scripts/update-last-sync.mjs            # rewrite the stamp for every package
//   node scripts/update-last-sync.mjs --check    # read-only validation; exit 1 on problems

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKGS = join(ROOT, "packages");
const UPSTREAM = "https://github.com/iamwrm/piagent-config/tree/main/packages";

// tech_pub directory name -> piagent-config source directory name (only when they differ).
const SOURCE_DIR = {
  "pi-dynamic-workflow": "pi-dynamic-workflow-rencc",
};

function listPackages() {
  return readdirSync(PKGS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function expectedUpstream(name) {
  return `${UPSTREAM}/${SOURCE_DIR[name] ?? name}`;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function render(name) {
  return JSON.stringify(
    { upstream: expectedUpstream(name), lastSync: nowIso() },
    null,
    2,
  ) + "\n";
}

const check = process.argv.includes("--check");
const problems = [];
const pkgs = listPackages();

for (const name of pkgs) {
  const file = join(PKGS, name, "last_sync_info.json");
  if (!existsSync(file)) {
    problems.push(`${name}: missing last_sync_info.json`);
    continue;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    problems.push(`${name}: invalid JSON (${err.message})`);
    continue;
  }
  const expected = expectedUpstream(name);
  if (data.upstream !== expected) {
    problems.push(
      `${name}: upstream ${JSON.stringify(data.upstream)} != expected ${JSON.stringify(expected)}`,
    );
  }
  if (typeof data.lastSync !== "string" || Number.isNaN(Date.parse(data.lastSync))) {
    problems.push(`${name}: lastSync is not a valid ISO timestamp (${JSON.stringify(data.lastSync)})`);
  } else if (Date.parse(data.lastSync) > Date.now() + 60_000) {
    problems.push(`${name}: lastSync is in the future (${data.lastSync})`);
  }
}

if (check) {
  if (problems.length) {
    console.error("last_sync_info.json problems:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OK: ${pkgs.length} packages have valid last_sync_info.json`);
} else {
  for (const name of pkgs) {
    writeFileSync(join(PKGS, name, "last_sync_info.json"), render(name));
  }
  console.log(`Updated lastSync stamps for ${pkgs.length} packages.`);
}
