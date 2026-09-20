import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { MessageSnapshot } from "../src/assistant-message.ts";
import { buildWrappedFeedback } from "../src/feedback.ts";
import type { Annotation } from "../src/protocol.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/wrap-golden");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

function loadGolden(name: string): string {
  const raw = readFileSync(join(fixtureDir, name), "utf8");
  assert.ok(raw.endsWith("\n"), `${name} must be POSIX text (trailing newline)`);
  return raw.slice(0, -1);
}

function assertMatchesGolden(kind: "message" | "file"): void {
  const snapshot = loadJson(`${kind}-snapshot.json`) as MessageSnapshot;
  const annotations = loadJson(`${kind}-annotations.json`) as Annotation[];
  const actual = buildWrappedFeedback(snapshot, annotations);
  assert.equal(actual, loadGolden(`${kind}.golden.md`));
}

test("TS wrap matches the message golden fixture", () => {
  assertMatchesGolden("message");
});

test("TS wrap matches the file golden fixture", () => {
  assertMatchesGolden("file");
});
