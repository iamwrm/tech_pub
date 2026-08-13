import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import unifiedEdit from "../unified-edit.ts";

interface CapturedTool {
  definition?: ToolDefinition<any, any>;
}

function registerTool(): ToolDefinition<any, any> {
  let definition: ToolDefinition<any, any> | undefined;
  const pi = {
    registerTool: (registered: ToolDefinition<any, any>) => {
      definition = registered;
    },
  } as any;
  unifiedEdit(pi);
  assert.ok(definition, "extension must register a tool");
  assert.equal(definition.name, "edit");
  return definition;
}

type ExecuteResult = Awaited<ReturnType<NonNullable<ToolDefinition<any, any>["execute"]>>>;

function resultText(result: ExecuteResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => (item as { type: "text"; text: string }).text)
    .join("\n");
}

async function runEdit(cwd: string, text: string, mode: string = "rows"): Promise<ExecuteResult> {
  const prev = process.env.PI_UNIFIED_EDIT_MODE;
  process.env.PI_UNIFIED_EDIT_MODE = mode;
  const definition = registerTool();
  const params = (definition.prepareArguments as (args: unknown) => any)({ text });
  return definition.execute("smoke-call", params, undefined, undefined, { cwd } as any);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-unified-edit-"));
}

test("row script: @REPLACE rewrites one block in one file", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "pkg.json"), '{\n  "version": "1.0.0",\n  "name": "x"\n}\n');
    const result = await runEdit(root, [
      "[pkg.json]",
      "@REPLACE",
      '-  "version": "1.0.0",',
      '+  "version": "1.0.1",',
    ].join("\n"));
    assert.match(resultText(result), /Edited pkg\.json/);
    assert.match(readFileSync(join(root, "pkg.json"), "utf8"), /"version": "1\.0\.1"/);
    assert.match(result.details.diff, /1\.0\.1/);
    assert.match(result.details.patch, /^--- |^\+\+\+ /m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("row script: line ops, append, delete and multiple files in one call", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "a.ts"), "line1\nline2\nline3\nline4\nline5\n");
    writeFileSync(join(root, "b.ts"), "tail\n");
    const result = await runEdit(root, [
      "[a.ts]",
      "@INS.PRE 1",
      "+import { x } from \"./x\";",
      "@DEL 3-4",
      "@REPLACE",
      "-line5",
      "+line5b",
      "[b.ts]",
      "@APPEND",
      "+appended",
    ].join("\n"));
    assert.match(resultText(result), /2 file\(s\)/);
    assert.equal(
      readFileSync(join(root, "a.ts"), "utf8"),
      'import { x } from "./x";\nline1\nline4\nline5b\n',
    );
    assert.equal(readFileSync(join(root, "b.ts"), "utf8"), "tail\nappended\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("row script: anchored insert with the fuzzy matcher tolerates whitespace drift", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "main.ts"), "export function main() {\n  return 1;\n}\n");
    const result = await runEdit(root, [
      "[main.ts]",
      "@INS.AFTER",
      "-export function main() {",
      '+  console.log("hi");',
    ].join("\n"));
    assert.match(resultText(result), /Edited main\.ts/);
    assert.equal(
      readFileSync(join(root, "main.ts"), "utf8"),
      'export function main() {\n  console.log("hi");\n  return 1;\n}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch mode: add, update with context hunks, and delete files", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "old.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(root, "gone.txt"), "delete me\n");
    const result = await runEdit(root, [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hello",
      "+world",
      "*** Update File: old.txt",
      "@@ alpha",
      "-beta",
      "+beta2",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ].join("\n"), "patch");
    assert.match(resultText(result), /3 file\(s\)/);
    assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "hello\nworld\n");
    assert.equal(readFileSync(join(root, "old.txt"), "utf8"), "alpha\nbeta2\ngamma\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch mode: delete-file on a missing file fails before mutating anything", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "keep.txt"), "keep\n");
    await assert.rejects(
      runEdit(root, [
        "*** Begin Patch",
        "*** Delete File: missing.txt",
        "*** End Patch",
      ].join("\n"), "patch"),
      /does not exist/,
    );
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareArguments accepts a raw string payload and {patch} object key", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "f.txt"), "one\n");
    await runEdit(root, "[f.txt]\n@APPEND\n+two");
    assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "one\ntwo\n");

    const definition = registerTool();
    const params = (definition.prepareArguments as (args: unknown) => any)({ patch: "[f.txt]\n@APPEND\n+three" });
    await definition.execute("smoke-call-2", params, undefined, undefined, { cwd: root } as any);
    assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "one\ntwo\nthree\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed row scripts produce parse errors and touch nothing", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "f.txt"), "keep\n");
    await assert.rejects(runEdit(root, "[f.txt]\n@REPLACE\n+x only, no anchor"), /no - rows to locate/);
    await assert.rejects(runEdit(root, "@REPLACE\n-a\n+b"), /expected a \[filename\] header/);
    assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
