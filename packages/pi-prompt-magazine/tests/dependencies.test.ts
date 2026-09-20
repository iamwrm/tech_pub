import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { databaseDependencyAvailable, ensureDatabaseDependency, INSTALL_ARGS, INSTALL_LOCK, runInstallProcess } from "../dependencies.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "magazine-dependencies-"));
  writeFileSync(join(dir, "package.json"), '{"name":"isolated-fixture"}');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function putDependency(dir: string, source = "module.exports = class { close() {} };") {
  const root = join(dir, "node_modules", "better-sqlite3");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"better-sqlite3","main":"index.cjs"}');
  writeFileSync(join(root, "index.cjs"), source);
}

test("healthy dependency bypasses npm, progress, and filesystem locks even with opt-out", async () => {
  const f = fixture();
  try {
    putDependency(f.dir);
    await ensureDatabaseDependency({ packageDir: f.dir, autoInstall: false,
      install: async () => assert.fail("must not install"), onProgress: () => assert.fail("must be silent") });
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
  } finally { f.cleanup(); }
});

test("missing dependency installs in package directory and retries in the same process", async () => {
  const f = fixture();
  try {
    assert.equal(databaseDependencyAvailable(f.dir), false);
    let installs = 0;
    const messages: string[] = [];
    await ensureDatabaseDependency({ packageDir: f.dir, onProgress: (text) => messages.push(text),
      install: async (cwd) => {
        installs++;
        assert.equal(cwd, f.dir);
        assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), true);
        putDependency(cwd);
      } });
    assert.equal(installs, 1);
    assert.equal(messages.length, 2);
    assert.equal(databaseDependencyAvailable(f.dir), true);
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
    assert.ok(INSTALL_ARGS.includes("--save=false"));
    assert.ok(INSTALL_ARGS.includes("--omit=dev"));
  } finally { f.cleanup(); }
});

test("opt-out fails with manual recovery and never invokes npm", async () => {
  const f = fixture();
  try {
    await assert.rejects(ensureDatabaseDependency({ packageDir: f.dir, autoInstall: false,
      install: async () => assert.fail("must not install") }), /PI_PROMPT_MAGAZINE_AUTO_INSTALL=0.*Run npm install/s);
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
  } finally { f.cleanup(); }
});

for (const [label, source] of [
  ["native ABI mismatch", "module.exports = class { constructor() { throw new Error('NODE_MODULE_VERSION mismatch'); } };"],
  ["missing transitive dependency", "require('nonexistent-magazine-transitive-dependency');"],
]) {
  test(`${label} must not trigger installation`, async () => {
    const f = fixture();
    try {
      putDependency(f.dir, source);
      await assert.rejects(ensureDatabaseDependency({ packageDir: f.dir,
        install: async () => assert.fail("must not install") }), /NODE_MODULE_VERSION|nonexistent-magazine-transitive/);
      assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
    } finally { f.cleanup(); }
  });
}

test("installation failure reports diagnostics and releases only its own lock", async () => {
  const f = fixture();
  try {
    await assert.rejects(ensureDatabaseDependency({ packageDir: f.dir,
      install: async () => { throw new Error("\x1b[31moffline\x1b[0m"); } }), (error: Error) => {
      assert.match(error.message, /offline.*Run npm install/s);
      assert.ok(!error.message.includes("\x1b"));
      return true;
    });
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
    await assert.rejects(ensureDatabaseDependency({ packageDir: f.dir,
      install: async () => {} }), /npm finished but better-sqlite3 is still missing/);
  } finally { f.cleanup(); }
});

test("parallel callers serialize installation and recheck after acquiring lock", async () => {
  const f = fixture();
  try {
    let installs = 0;
    const install = async () => { installs++; await delay(150); putDependency(f.dir); };
    await Promise.all(Array.from({ length: 4 }, () => ensureDatabaseDependency({ packageDir: f.dir, install })));
    assert.equal(installs, 1);
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
  } finally { f.cleanup(); }
});

test("a held lock prevents loading partial packages and is never stolen on timeout", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, INSTALL_LOCK));
    putDependency(f.dir, "throw new Error('partial install must not be loaded');");
    await assert.rejects(ensureDatabaseDependency({ packageDir: f.dir, lockTimeoutMs: 0 }), /Timed out waiting.*verify no npm installation/s);
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), true);
  } finally { f.cleanup(); }
});

test("lock wait is abortable without removing another process's lock", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, INSTALL_LOCK));
    const controller = new AbortController();
    const pending = ensureDatabaseDependency({ packageDir: f.dir, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), true);
  } finally { f.cleanup(); }
});

test("independent processes share the same installation lock", async () => {
  const f = fixture();
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const runWorker = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", join(packageDir, "tests/dependencies-worker.ts"), f.dir], {
        cwd: packageDir, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(output)));
    });
    await Promise.all([runWorker(), runWorker(), runWorker()]);
    assert.equal(readFileSync(join(f.dir, "installs"), "utf8"), "install\n");
    assert.equal(existsSync(join(f.dir, INSTALL_LOCK)), false);
  } finally { f.cleanup(); }
});

test("process runner uses cwd, captures bounded sanitized output, and reports exit failures", async () => {
  const f = fixture();
  try {
    await runInstallProcess(process.execPath, ["-e", "require('fs').writeFileSync('cwd-check', process.cwd())"], f.dir);
    // process.cwd() reports the canonical path (/private/var/... on macOS), while the fixture uses the tmpdir spelling.
    assert.equal(realpathSync(readFileSync(join(f.dir, "cwd-check"), "utf8")), realpathSync(f.dir));
    await assert.rejects(runInstallProcess(process.execPath, ["-e", "console.error('x'.repeat(30000) + '\\x1b[31mtail\\x1b[0m'); process.exit(7)"], f.dir), (error: Error) => {
      assert.match(error.message, /exit code 7/);
      assert.match(error.message, /tail/);
      assert.ok(error.message.length < 8500);
      assert.ok(!error.message.includes("\x1b"));
      return true;
    });
    await assert.rejects(runInstallProcess(join(f.dir, "missing-npm"), [], f.dir), /ENOENT/);
  } finally { f.cleanup(); }
});

test("process runner enforces timeout and cancellation", async () => {
  const f = fixture();
  try {
    await assert.rejects(runInstallProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], f.dir, undefined, 100), /timed out/);
    const controller = new AbortController();
    const pending = runInstallProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], f.dir, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await assert.rejects(runInstallProcess(process.execPath, [], f.dir, controller.signal), /abort/i);
  } finally { f.cleanup(); }
});
