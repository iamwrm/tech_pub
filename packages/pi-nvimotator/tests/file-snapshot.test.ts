import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { SnapshotError } from "../src/assistant-message.ts";
import {
  MAX_FILE_SNAPSHOT_BYTES,
  captureFileSnapshot,
  classifyAnnotateFileName,
  completeAnnotatePath,
  listAnnotatableFiles,
  parseAnnotatePathArg,
  resolveAnnotateFilePath,
} from "../src/file-snapshot.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-nvimotator-file-"));
}

test("path args strip matching quotes and reject URLs as remote", async () => {
  assert.equal(parseAnnotatePathArg('  "docs/notes.md"  '), "docs/notes.md");
  assert.equal(parseAnnotatePathArg("'docs/notes.md'"), "docs/notes.md");
  await assert.rejects(
    resolveAnnotateFilePath("https://example.com/guide", process.cwd()),
    /local files only/,
  );
  await assert.rejects(
    resolveAnnotateFilePath("http://localhost:3000/", process.cwd()),
    /local files only/,
  );
  await assert.rejects(resolveAnnotateFilePath("", process.cwd()), /Usage: \/nvim-annotate <path>/);
});

test("allowlist accepts documents and source, rejects secrets and unknown types", () => {
  assert.equal(classifyAnnotateFileName("notes.md"), "document");
  assert.equal(classifyAnnotateFileName("config.yaml"), "document");
  assert.equal(classifyAnnotateFileName(".env.example"), "document");
  assert.equal(classifyAnnotateFileName("index.html"), "document");
  assert.equal(classifyAnnotateFileName("bridge.ts"), "source");
  assert.equal(classifyAnnotateFileName("init.lua"), "source");
  assert.equal(classifyAnnotateFileName(".env"), "secret");
  assert.equal(classifyAnnotateFileName(".env.local"), "secret");
  assert.equal(classifyAnnotateFileName("id_rsa"), "secret");
  assert.equal(classifyAnnotateFileName("tls.pem"), "secret");
  assert.equal(classifyAnnotateFileName("photo.png"), "unsupported");
});

test("file snapshot reads UTF-8, normalizes CRLF, and marks kind=file", async () => {
  const root = await tempDir();
  const path = join(root, "notes.md");
  await writeFile(path, "alpha\r\nemoji 🙂 line\r\nomega");
  const snapshot = await captureFileSnapshot(path, "session-file");
  assert.equal(snapshot.kind, "file");
  assert.equal(snapshot.filePath, path);
  assert.equal(snapshot.text, "alpha\nemoji 🙂 line\nomega");
  assert.deepEqual(snapshot.lines, ["alpha", "emoji 🙂 line", "omega"]);
  assert.match(snapshot.entryId, /^file-[0-9a-f]{64}$/);
  assert.equal(snapshot.snapshotId.length, 64);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.lines));
});

test("file snapshot rejects missing, oversized, secret, binary, and source-disguised secrets", async () => {
  const root = await tempDir();
  await assert.rejects(captureFileSnapshot(join(root, "missing.md"), "session"), SnapshotError);
  await assert.rejects(captureFileSnapshot(join(root, "missing.md"), "session"), /does not exist/);

  const envPath = join(root, ".env");
  await writeFile(envPath, "SECRET=1\n");
  await assert.rejects(captureFileSnapshot(envPath, "session"), /secrets/);

  const envLocal = join(root, ".env.production");
  await writeFile(envLocal, "SECRET=1\n");
  await assert.rejects(resolveAnnotateFilePath(envLocal, root), /secrets/);

  const png = join(root, "photo.png");
  await writeFile(png, "not actually a png");
  await assert.rejects(captureFileSnapshot(png, "session"), /Unsupported file type/);

  const huge = join(root, "huge.md");
  await writeFile(huge, "x".repeat(MAX_FILE_SNAPSHOT_BYTES + 1));
  await assert.rejects(captureFileSnapshot(huge, "session"), /larger than/);

  const binary = join(root, "binary.md");
  await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
  await assert.rejects(captureFileSnapshot(binary, "session"), /binary/);

  const secretTarget = join(root, ".env");
  const disguised = join(root, "notes.md");
  await symlink(secretTarget, disguised);
  await assert.rejects(captureFileSnapshot(disguised, "session"), /secrets/);
});

test("source files are allowed and still captured as file snapshots", async () => {
  const root = await tempDir();
  const path = join(root, "bridge.ts");
  await writeFile(path, "export const x = 1;\n");
  const snapshot = await captureFileSnapshot(path, "session-ts");
  assert.equal(snapshot.kind, "file");
  assert.equal(snapshot.filePath, path);
  assert.match(snapshot.text, /export const x = 1;/);
});

test("a folder picks one allowlisted file and ignores secrets", async () => {
  const root = await tempDir();
  await writeFile(join(root, "notes.md"), "# notes\n");
  await writeFile(join(root, "config.yaml"), "a: 1\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await writeFile(join(root, "photo.png"), "nope");
  const listed = await listAnnotatableFiles(root);
  assert.deepEqual(listed.map((path) => basename(path)), ["config.yaml", "notes.md"]);

  const picked = await resolveAnnotateFilePath(root, root, async (files) => files.find((file) => basename(file) === "notes.md"));
  assert.equal(basename(picked), "notes.md");

  await assert.rejects(
    resolveAnnotateFilePath(root, root, async () => undefined),
    /No file was selected/,
  );

  const nested = join(root, "empty");
  await mkdir(nested);
  await assert.rejects(resolveAnnotateFilePath(nested, root), /No annotatable files/);

  const single = join(root, "one");
  await mkdir(single);
  await writeFile(join(single, "only.md"), "x\n");
  const auto = await resolveAnnotateFilePath(single, root);
  assert.equal(basename(auto), "only.md");
});

test("path completions stay local and skip secrets", async () => {
  const root = await tempDir();
  await writeFile(join(root, "notes.md"), "x\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await mkdir(join(root, "docs"));
  const completions = completeAnnotatePath("", root);
  assert.ok(completions.some((item) => item.label === "notes.md"));
  assert.ok(completions.some((item) => item.label === "docs/"));
  assert.ok(!completions.some((item) => item.label.includes(".env")));
  assert.deepEqual(completeAnnotatePath("https://example.com", root), []);
});
