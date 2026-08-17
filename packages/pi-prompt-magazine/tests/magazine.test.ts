/**
 * Unit tests for the pure magazine queue model (magazine.ts).
 * Run with: node --experimental-strip-types --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearMagazine,
  countMagazine,
  createMagazineState,
  MAGAZINE_MAX,
  moveEntry,
  parseStashIntent,
  popFront,
  previewLine,
  pushStash,
  removeAt,
  STASH_MARKER,
} from "../magazine.ts";

test("pushStash appends to the back (FIFO load)", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "first"));
  ({ state: s } = pushStash(s, "second"));
  assert.equal(countMagazine(s), 2);
  assert.deepEqual(s.queue.map((e) => e.text), ["first", "second"]);
  assert.ok(s.queue.every((e) => e.id.length > 0 && typeof e.createdAt === "number"));
});

test("popFront removes the oldest draft (FIFO unload)", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "first"));
  ({ state: s } = pushStash(s, "second"));
  const r1 = popFront(s);
  assert.equal(r1.entry?.text, "first");
  assert.equal(countMagazine(r1.state), 1);
  const r2 = popFront(r1.state);
  assert.equal(r2.entry?.text, "second");
  assert.equal(countMagazine(r2.state), 0);
  const r3 = popFront(r2.state);
  assert.equal(r3.entry, undefined);
});

test("pushStash past MAGAZINE_MAX drops the oldest and reports it", () => {
  let s = createMagazineState();
  for (let i = 0; i < MAGAZINE_MAX; i++) {
    ({ state: s } = pushStash(s, `draft-${i}`));
  }
  assert.equal(countMagazine(s), MAGAZINE_MAX);
  const r = pushStash(s, "overflow");
  assert.equal(countMagazine(r.state), MAGAZINE_MAX);
  assert.equal(r.dropped?.text, "draft-0");
  assert.equal(r.state.queue.at(-1)?.text, "overflow");
});

test("removeAt deletes the selected index; out of range is a no-op", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "a"));
  ({ state: s } = pushStash(s, "b"));
  ({ state: s } = pushStash(s, "c"));
  const r = removeAt(s, 1);
  assert.equal(r.entry?.text, "b");
  assert.deepEqual(r.state.queue.map((e) => e.text), ["a", "c"]);
  const noop = removeAt(r.state, 5);
  assert.equal(noop.entry, undefined);
  assert.equal(noop.state, r.state);
  const neg = removeAt(r.state, -1);
  assert.equal(neg.entry, undefined);
});

test("moveEntry reorders and clamps", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "a"));
  ({ state: s } = pushStash(s, "b"));
  ({ state: s } = pushStash(s, "c"));
  // move c to front
  s = moveEntry(s, 2, 0);
  assert.deepEqual(s.queue.map((e) => e.text), ["c", "a", "b"]);
  // clamp out-of-range target to the ends
  s = moveEntry(s, 0, 99);
  assert.deepEqual(s.queue.map((e) => e.text), ["a", "b", "c"]);
  // same position: no-op (same reference)
  const same = moveEntry(s, 1, 1);
  assert.equal(same, s);
});

test("clearMagazine empties the queue", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "a"));
  const cleared = clearMagazine();
  assert.equal(countMagazine(cleared), 0);
  assert.deepEqual(cleared.queue, []);
});

test("previewLine collapses whitespace and truncates", () => {
  assert.equal(previewLine("  fix   the   typo  "), "fix the typo");
  assert.equal(previewLine("line1\nline2"), "line1");
  const long = "x".repeat(100);
  const preview = previewLine(long, 20);
  assert.equal(preview.length, 20);
  assert.ok(preview.endsWith("…"));
});

test("previewLine strips terminal control sequences", () => {
  const preview = previewLine("safe\u001b]52;c;ZXZpbA==\u0007 text\u009b31m");
  assert.doesNotMatch(preview, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(preview, /^safe/);
});

test("parseStashIntent: plain drafts pass through", () => {
  assert.deepEqual(parseStashIntent("just a normal prompt"), { kind: "none" });
  assert.deepEqual(parseStashIntent(""), { kind: "none" });
  assert.deepEqual(parseStashIntent("   "), { kind: "none" });
  // marker in the middle of a multi-line draft is left alone
  assert.deepEqual(parseStashIntent("line one;;\nline two"), { kind: "none" });
  // a single trailing semicolon does not trigger
  assert.deepEqual(parseStashIntent("hello ;"), { kind: "none" });
});

test("parseStashIntent: trailing ;; stashes the whole draft", () => {
  assert.deepEqual(parseStashIntent("fix the typo;;"), { kind: "stash", text: "fix the typo" });
  assert.deepEqual(parseStashIntent("fix the typo ;;"), { kind: "stash", text: "fix the typo" });
  // trailing whitespace after the marker is tolerated
  assert.deepEqual(parseStashIntent("hello ;; "), { kind: "stash", text: "hello" });
  // multi-line: marker on the last line
  assert.deepEqual(parseStashIntent("line one\nline two;;"), { kind: "stash", text: "line one\nline two" });
  // marker as its own last line
  assert.deepEqual(parseStashIntent("line one\n;;"), { kind: "stash", text: "line one" });
  // trailing whitespace after the marker is tolerated
  assert.deepEqual(parseStashIntent("line one;;  \n"), { kind: "stash", text: "line one" });
  // inner line trailing whitespace is preserved
  assert.deepEqual(parseStashIntent("line one  \nline two;;"), { kind: "stash", text: "line one  \nline two" });
});

test("parseStashIntent: bare ;; opens the magazine", () => {
  assert.deepEqual(parseStashIntent(";;"), { kind: "open" });
  assert.deepEqual(parseStashIntent("  ;;  "), { kind: "open" });
  assert.deepEqual(parseStashIntent("\n;;"), { kind: "open" });
});

test("parseStashIntent: ;;; escapes to a literal ;; send", () => {
  assert.deepEqual(parseStashIntent("foo;;;"), { kind: "send", text: "foo;;" });
  assert.deepEqual(parseStashIntent("foo ;;;"), { kind: "send", text: "foo ;;" });
  // more than three: strips exactly one semicolon
  assert.deepEqual(parseStashIntent("foo;;;;"), { kind: "send", text: "foo;;;" });
});

test("STASH_MARKER is the documented two-semicolon marker", () => {
  assert.equal(STASH_MARKER, ";;");
});
