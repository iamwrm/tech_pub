import assert from "node:assert/strict";
import { test } from "node:test";
import { placeContinuityMessage } from "../src/continuity-placement.ts";
import type { LiveContextMessage } from "../src/types.ts";

const note = { role: "custom", customType: "live-context-continuity", content: "Keep the obligation", timestamp: 0 };
const prefix: LiveContextMessage[] = [{ role: "user", content: "Task" }];
const tail: LiveContextMessage[] = [
  { role: "assistant", content: [{ type: "thinking", thinking: "summary", thinkingSignature: "opaque" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "fixture" } }] },
  { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "result" }] },
];

test("fixed projection boundary preserves the whole previous request as a prefix", () => {
  const before = placeContinuityMessage(prefix, note, prefix.length);
  const after = placeContinuityMessage([...prefix, ...tail], note, prefix.length);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length), tail);
  assert.equal(after[2], tail[0], "opaque reasoning and tool-call objects stay unchanged");
  assert.equal(after[3], tail[1]);
});

test("raw contexts use a stable leading note rather than a moving last-user boundary", () => {
  const before = placeContinuityMessage(prefix, note);
  const after = placeContinuityMessage([...prefix, ...tail], note);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after[0], note);
});

test("no note is an identity operation and input arrays are never mutated", () => {
  const input = [...prefix, ...tail];
  const copy = structuredClone(input);
  assert.equal(placeContinuityMessage(input, undefined, 1), input);
  placeContinuityMessage(input, note, 1);
  assert.deepEqual(input, copy);
});

test("new revisions and updated annotations select a new fixed prefix without retaining stale notes", () => {
  const changed = { ...note, content: "Updated obligation" };
  const result = placeContinuityMessage([...prefix, ...tail], changed, 3);
  assert.equal(result[3], changed);
  assert.equal(result.includes(note), false);
  assert.deepEqual(placeContinuityMessage([], note, 12), [note]);
  assert.deepEqual(placeContinuityMessage(prefix, note, -1), [note, ...prefix]);
});
