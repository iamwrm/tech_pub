import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function listFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

export function hashTree(root) {
  const hash = createHash("sha256");
  for (const path of listFiles(root)) {
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update("\0");
    hash.update((statSync(path).mode & 0o777).toString(8));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parseSkillFrontmatter(path) {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---\n")) return { text, frontmatter: null };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { text, frontmatter: null };
  const frontmatter = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[match[1]] = value;
  }
  return { text, frontmatter };
}

export function discoverSkillDirs(skillsRoot) {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

const BANNED_COMPATIBILITY_MARKERS = [
  [/(^|[\s`])~?\/?\.cursor\//m, ".cursor path"],
  [/\bAskQuestion\b/, "Cursor AskQuestion tool"],
  [/\bsubagent_type\b/, "Cursor subagent_type"],
  [/\bgeneralPurpose\b/, "Cursor generalPurpose agent"],
  [/\bCursor cloud\b/i, "Cursor cloud agent"],
  [/\bcursor-team-kit\b/i, "cursor-team-kit dependency"],
  [/Cursor(?:'s)? built-in/i, "Cursor built-in dependency"],
  [/(^|\s)\/loop(?:\s|`|$)/m, "Cursor /loop command"],
  [/\bTask (?:tool|call|subagent)/, "Cursor Task tool"],
];

function validateLinks(filePath, text, errors) {
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split("#", 1)[0].split("?", 1)[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {}
    const resolved = resolve(dirname(filePath), target);
    if (!existsSync(resolved)) errors.push(`${filePath}: unresolved relative link ${match[1]}`);
  }
}

export function validateProvenance(packageRoot, lock, vendorRoot = join(packageRoot, "vendor", "pstack")) {
  const errors = [];
  if (!existsSync(vendorRoot)) return [`${vendorRoot}: vendored upstream snapshot is missing`];
  if (lock.upstreamTreeHash && lock.upstreamTreeHash !== "pending" && lock.upstreamTreeHash !== hashTree(vendorRoot)) {
    errors.push(`${vendorRoot}: upstreamTreeHash does not match the lock`);
  }
  const pluginPath = join(vendorRoot, ".cursor-plugin", "plugin.json");
  if (!existsSync(pluginPath)) errors.push(`${pluginPath}: upstream plugin manifest is missing`);
  else if (readJson(pluginPath).version !== lock.upstreamVersion) {
    errors.push(`${pluginPath}: upstream version does not match the lock`);
  }
  const patchsetRoot = join(packageRoot, "compat");
  if (lock.patchsetHash && lock.patchsetHash !== "pending" && lock.patchsetHash !== hashTree(patchsetRoot)) {
    errors.push(`${patchsetRoot}: patchsetHash does not match the lock`);
  }
  const noticePath = join(packageRoot, "THIRD_PARTY_NOTICES.md");
  if (!existsSync(noticePath)) errors.push(`${noticePath}: attribution notice is missing`);
  else {
    const notice = readFileSync(noticePath, "utf8");
    if (!notice.includes(lock.commit)) errors.push(`${noticePath}: upstream commit does not match the lock`);
    if (!notice.includes(`Plugin version: \`${lock.upstreamVersion}\``)) {
      errors.push(`${noticePath}: upstream plugin version does not match the lock`);
    }
  }
  return errors;
}

export function validateGeneratedPackage(packageRoot, options = {}) {
  const skillsRoot = options.skillsRoot ?? join(packageRoot, "skills");
  const errors = [];
  const warnings = [];
  const skillDirs = discoverSkillDirs(skillsRoot);
  const names = new Map();

  if (skillDirs.length === 0) errors.push(`${skillsRoot}: no skills discovered`);

  for (const dirName of skillDirs) {
    const skillFile = join(skillsRoot, dirName, "SKILL.md");
    const { frontmatter } = parseSkillFrontmatter(skillFile);
    if (!frontmatter) {
      errors.push(`${skillFile}: missing or malformed frontmatter`);
      continue;
    }
    const name = frontmatter.name;
    const description = frontmatter.description;
    if (!name) errors.push(`${skillFile}: missing name`);
    else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push(`${skillFile}: invalid Pi skill name ${name}`);
    else if (names.has(name)) errors.push(`${skillFile}: duplicate skill name ${name} also used by ${names.get(name)}`);
    else names.set(name, skillFile);
    if (!description) errors.push(`${skillFile}: missing description`);
    if (name && name !== dirName) warnings.push(`${skillFile}: directory differs from skill name ${name}`);
  }

  for (const path of listFiles(skillsRoot).filter((path) => path.endsWith(".md"))) {
    const text = readFileSync(path, "utf8");
    validateLinks(path, text, errors);
    for (const [pattern, label] of BANNED_COMPATIBILITY_MARKERS) {
      if (pattern.test(text)) errors.push(`${path}: unsupported ${label}`);
    }
  }

  const dependencyPath = join(packageRoot, "compat", "dependencies.json");
  if (existsSync(dependencyPath)) {
    const dependencies = readJson(dependencyPath);
    const selected = new Set(skillDirs);
    for (const [skill, required] of Object.entries(dependencies)) {
      if (!selected.has(skill)) continue;
      for (const dependency of required) {
        if (!selected.has(dependency)) errors.push(`${skill}: required skill ${dependency} is filtered out`);
      }
    }
  }


  const lockPath = join(packageRoot, "UPSTREAM.lock.json");
  if (!options.skipLock && existsSync(lockPath)) {
    const lock = readJson(lockPath);
    if (JSON.stringify(lock.includedSkills ?? []) !== JSON.stringify(skillDirs)) {
      errors.push(`${lockPath}: includedSkills does not match generated skills`);
    }
    if (lock.generatedTreeHash && lock.generatedTreeHash !== "pending" && lock.generatedTreeHash !== hashTree(skillsRoot)) {
      errors.push(`${lockPath}: generatedTreeHash does not match skills/`);
    }
    errors.push(...validateProvenance(packageRoot, lock));
  }

  return { errors, warnings, skillDirs };
}

export function assertValidGeneratedPackage(packageRoot, options = {}) {
  const result = validateGeneratedPackage(packageRoot, options);
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  return result;
}
