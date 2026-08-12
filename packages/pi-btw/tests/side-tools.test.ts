import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CORE_TOOL_NAMES, coreToolLabel, createCoreAgentTools } from "../side-tools.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-btw-side-tools-"));
}

test("createCoreAgentTools returns the seven core tools in stable order", () => {
  const tools = createCoreAgentTools("/tmp");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...CORE_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.ok(tool.label);
    assert.ok(tool.description);
    assert.ok(tool.parameters);
    assert.equal(typeof tool.execute, "function");
  }
  assert.equal(coreToolLabel([]), "no tools");
  assert.equal(coreToolLabel(["read"]), "1 tool");
  assert.equal(coreToolLabel(["read", "write"]), "2 tools");
});

test("read tool executes against the frozen branch cwd", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "a.txt"), "hello side branch\n");
    const [read] = createCoreAgentTools(root);
    assert.equal(read.name, "read");
    const result = await read.execute("call-1", { path: "a.txt" });
    const text = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => (item as { type: "text"; text: string }).text)
      .join("\n");
    assert.match(text, /hello side branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bash tool executes and returns stdout", async () => {
  const root = tempDir();
  try {
    const [,,, bash] = createCoreAgentTools(root);
    assert.equal(bash.name, "bash");
    const result = await bash.execute("call-2", {
      command: "printf 'side-branch-ok\\n'",
    });
    const text = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => (item as { type: "text"; text: string }).text)
      .join("\n");
    assert.match(text, /side-branch-ok/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit tool rewrites a file through the wrapped definition", async () => {
  const root = tempDir();
  try {
    writeFileSync(join(root, "f.txt"), "one\ntwo\n");
    const [,, edit] = createCoreAgentTools(root);
    assert.equal(edit.name, "edit");
    await edit.execute("call-3", {
      path: "f.txt",
      edits: [{ oldText: "one\n", newText: "uno\n" }],
    });
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "uno\ntwo\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
