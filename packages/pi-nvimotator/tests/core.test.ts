import assert from "node:assert/strict";
import test from "node:test";
import { captureLatestAssistantSnapshot, MAX_SNAPSHOT_BYTES, SnapshotError } from "../src/assistant-message.ts";
import { buildRawFeedback, buildWrappedFeedback, excerptForAnchor, FeedbackError } from "../src/feedback.ts";
import { parseRequest, PROTOCOL_VERSION, QUICK_ACTIONS, type Annotation } from "../src/protocol.ts";
import { SubmissionError, SubmissionStore } from "../src/submission.ts";

function snapshot(text = "alpha\nemoji 🙂 line\nomega") {
  return captureLatestAssistantSnapshot([
    { id: "old", type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
    { id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
    { id: "entry-1", type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "secret" },
      { type: "text", text: text.replaceAll("\n", "\r\n") },
      { type: "toolCall", name: "ignored" },
    ] } },
  ], "session-1");
}

const annotations: Annotation[] = [
  {
    id: "a1",
    kind: "comment",
    anchor: { selection: "line", startLine: 1, startByte: 0, endLine: 1, endByte: 5 },
    comment: "Keep this\nwith care",
  },
  {
    id: "a2",
    kind: "quickAction",
    anchor: { selection: "character", startLine: 2, startByte: 6, endLine: 2, endByte: 10 },
    actionId: "missing-overview",
  },
  { id: "a3", kind: "comment", comment: "General note" },
];

test("assistant extraction uses the latest assistant text blocks and normalizes CRLF", () => {
  const value = snapshot();
  assert.equal(value.text, "alpha\nemoji 🙂 line\nomega");
  assert.deepEqual(value.lines, ["alpha", "emoji 🙂 line", "omega"]);
  assert.equal(value.entryId, "entry-1");
  assert.equal(value.messageHash.length, 64);
  assert.equal(value.snapshotId.length, 64);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.lines));
});

test("assistant extraction skips empty entries and enforces hard size limits", () => {
  const selected = captureLatestAssistantSnapshot([
    { id: "old", type: "message", message: { role: "assistant", content: [{ type: "text", text: "usable" }] } },
    { id: "new", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "only" }] } },
  ], "session");
  assert.equal(selected.entryId, "old");
  assert.throws(() => captureLatestAssistantSnapshot([
    { id: "empty", type: "message", message: { role: "assistant", content: [{ type: "text", text: "  " }] } },
  ], "session"), SnapshotError);
  assert.throws(() => snapshot("x".repeat(MAX_SNAPSHOT_BYTES + 1)), /larger/);
});

test("feedback derives excerpts server-side with UTF-8 byte boundaries", () => {
  const value = snapshot();
  assert.equal(excerptForAnchor(value, annotations[0]!.anchor!), "alpha");
  assert.equal(excerptForAnchor(value, annotations[1]!.anchor!), "🙂");
  assert.throws(() => excerptForAnchor(value, {
    selection: "character", startLine: 2, startByte: 7, endLine: 2, endByte: 10,
  }), FeedbackError);
  const raw = buildRawFeedback(value, annotations);
  assert.match(raw, /Assistant entry: `entry-1`/);
  assert.match(raw, /> Keep this\n> with care/);
  assert.match(raw, /🗺️ Missing overview/);
  assert.match(raw, /> Provide a narrative overview of what is being built/);
  assert.match(raw, /General note/);
});

test("actions match Plannotator terminology and its exact ten default quick labels", () => {
  assert.deepEqual(QUICK_ACTIONS.slice(0, 2).map(({ id, label }) => [id, label]), [
    ["deletion", "Deletion"],
    ["thumbs-up", "👍 Looks good"],
  ]);
  assert.deepEqual(QUICK_ACTIONS.slice(2).map(({ id, label }) => [id, label]), [
    ["clarify-this", "❓ Clarify this"],
    ["missing-overview", "🗺️ Missing overview"],
    ["verify-this", "🔍 Verify this"],
    ["give-me-an-example", "🔬 Give me an example"],
    ["match-existing-patterns", "🧬 Match existing patterns"],
    ["consider-alternatives", "🔄 Consider alternatives"],
    ["ensure-no-regression", "📉 Ensure no regression"],
    ["out-of-scope", "🚫 Out of scope"],
    ["needs-tests", "🧪 Needs tests"],
    ["nice-approach", "👍 Nice approach"],
  ]);
  const value = snapshot();
  const directActions = buildRawFeedback(value, [
    { id: "delete", kind: "quickAction", anchor: annotations[0]!.anchor!, actionId: "deletion" },
    { id: "approve", kind: "quickAction", anchor: annotations[0]!.anchor!, actionId: "thumbs-up" },
  ]);
  assert.match(directActions, /Quick action: Deletion\n> I don't want this in the message\./);
  assert.match(directActions, /Quick action: 👍 Looks good/);
  assert.doesNotMatch(directActions, /👎|Quick action: .*\b(?:Good|Bad)\b/);
});

test("submission render and send are byte-identical and deduplicated", () => {
  const value = snapshot();
  let wrapperVersion = "first";
  const store = new SubmissionStore(value, (feedback) => `${wrapperVersion}\n${feedback}`);
  const rendered = store.render("submission-1", annotations);
  wrapperVersion = "second";
  store.replaceSnapshot({ ...value, lines: [...value.lines] });
  const sent: string[] = [];
  const first = store.schedule("submission-1", annotations, (prompt) => sent.push(prompt));
  const retry = store.schedule("submission-1", annotations, (prompt) => sent.push(prompt));
  assert.equal(first.prompt, rendered);
  assert.equal(retry.prompt, rendered);
  assert.equal(retry.alreadyScheduled, true);
  assert.deepEqual(sent, [rendered]);
  const keyOrderStore = new SubmissionStore(value, (feedback) => feedback);
  const original = keyOrderStore.render("key-order", [annotations[0]!]);
  const reordered = {
    comment: "Keep this\nwith care",
    anchor: { endByte: 5, endLine: 1, startByte: 0, startLine: 1, selection: "line" },
    kind: "comment",
    id: "a1",
  } as Annotation;
  assert.equal(keyOrderStore.render("key-order", [reordered]), original);
  assert.throws(() => store.render("submission-1", annotations.slice(0, 1)), SubmissionError);
});

test("submission cache rejects pressure without forgetting prior identities", () => {
  const value = snapshot();
  const store = new SubmissionStore(value, () => "x");
  for (let index = 0; index < 128; index += 1) store.render(`cached-${index}`, annotations);
  assert.throws(() => store.render("overflow", annotations), /cache is full/);
  assert.equal(store.render("cached-0", annotations), "x");
});

test("feedback fences nested backticks safely", () => {
  const value = snapshot("before ``` inside\nafter");
  const prompt = buildWrappedFeedback(value, [{
    id: "fence", kind: "comment",
    anchor: { selection: "line", startLine: 1, startByte: 0, endLine: 2, endByte: 5 },
    comment: "review",
  }], (feedback) => feedback);
  assert.match(prompt, /````markdown\nbefore ``` inside/);
});

test("protocol parser rejects unknown fields, duplicate IDs, and malformed anchors", () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "request-1",
    token: "token",
    bridgeId: 16,
    instanceId: "instance-1",
    sessionId: "session-1",
    snapshotId: "snapshot-1",
  };
  assert.equal(parseRequest({ ...base, type: "ping" }).ok, true);
  assert.equal(parseRequest({ ...base, type: "ping", extra: true }).ok, false);
  assert.equal(parseRequest({ ...base, type: "render", submissionId: "submission-1", annotations: [annotations[0], annotations[0]] }).ok, false);
  assert.equal(parseRequest({ ...base, type: "render", submissionId: "submission-1", annotations: [{
    id: "bad", kind: "comment", comment: "x",
    anchor: { selection: "line", startLine: 0, startByte: 0, endLine: 1, endByte: 1 },
  }] }).ok, false);
});
