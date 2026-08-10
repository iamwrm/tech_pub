/**
 * Unit tests for the pure magazine queue model (magazine.ts).
 * Run with: node --experimental-strip-types --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOp,
  clearMagazine,
  countMagazine,
  createMagazineState,
  MAGAZINE_MAX,
  moveEntry,
  opChangesState,
  parseMagazine,
  parseOp,
  parseStashIntent,
  popFront,
  previewLine,
  pushStash,
  removeAt,
  replayMagazine,
  serializeMagazine,
  serializeOp,
  serializeSnapshot,
  SNAPSHOT_EVERY,
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

test("serialize/parse round-trips", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "hello\nworld", 1234));
  const parsed = parseMagazine(serializeMagazine(s));
  assert.equal(countMagazine(parsed), 1);
  assert.equal(parsed.queue[0].text, "hello\nworld");
  assert.equal(parsed.queue[0].createdAt, 1234);
  assert.ok(parsed.queue[0].id);
});

test("parseMagazine is defensive against malformed payloads", () => {
  for (const bad of [undefined, null, 42, "nope", [], {}, { queue: "x" }, { queue: [1, null, { text: 7 }, { text: "ok", createdAt: "nope" }] }]) {
    const s = parseMagazine(bad);
    assert.ok(Array.isArray(s.queue));
    for (const e of s.queue) {
      assert.equal(typeof e.text, "string");
      assert.equal(typeof e.id, "string");
      assert.equal(typeof e.createdAt, "number");
    }
  }
  // malformed entries are skipped, valid ones survive
  const mixed = parseMagazine({ queue: [{ text: 7 }, { text: "kept" }, { text: "also" }] });
  assert.deepEqual(mixed.queue.map((e) => e.text), ["kept", "also"]);
});

test("parseMagazine caps oversized payloads at MAGAZINE_MAX", () => {
  const queue = Array.from({ length: MAGAZINE_MAX + 20 }, (_, i) => ({ text: `d${i}`, id: `id${i}`, createdAt: i }));
  const s = parseMagazine({ queue });
  assert.equal(countMagazine(s), MAGAZINE_MAX);
});

test("previewLine collapses whitespace and truncates", () => {
  assert.equal(previewLine("  fix   the   typo  "), "fix the typo");
  assert.equal(previewLine("line1\nline2"), "line1");
  const long = "x".repeat(100);
  const preview = previewLine(long, 20);
  assert.equal(preview.length, 20);
  assert.ok(preview.endsWith("…"));
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

test("parseStashIntent: bare ;; is ignored", () => {
  assert.deepEqual(parseStashIntent(";;"), { kind: "none" });
  assert.deepEqual(parseStashIntent("  ;;  "), { kind: "none" });
  assert.deepEqual(parseStashIntent("\n;;"), { kind: "none" });
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


test("op log: serialize/parse round-trips", () => {
  for (const op of [
    { kind: "add", text: "draft" },
    { kind: "remove", index: 2 },
    { kind: "move", from: 1, to: 3 },
    { kind: "clear" },
  ] as const) {
    assert.deepEqual(parseOp(serializeOp(op)), op);
  }
  // defensive: garbage is skipped
  for (const bad of [undefined, null, 42, "x", {}, { v: 1, kind: "add", text: "old" }, { v: 2, kind: "bogus" }]) {
    assert.equal(parseOp(bad), undefined);
  }
});

test("op log: applyOp mirrors the queue mutations", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "a"));
  ({ state: s } = pushStash(s, "b"));
  ({ state: s } = pushStash(s, "c"));
  s = applyOp(s, { kind: "remove", index: 1 });
  assert.deepEqual(s.queue.map((e) => e.text), ["a", "c"]);
  s = applyOp(s, { kind: "move", from: 1, to: 0 });
  assert.deepEqual(s.queue.map((e) => e.text), ["c", "a"]);
  s = applyOp(s, { kind: "clear" });
  assert.equal(countMagazine(s), 0);
  s = applyOp(s, { kind: "add", text: "d" });
  assert.deepEqual(s.queue.map((e) => e.text), ["d"]);
});

test("op log: opChangesState rejects no-ops", () => {
  let s = createMagazineState();
  ({ state: s } = pushStash(s, "a"));
  ({ state: s } = pushStash(s, "b"));
  assert.equal(opChangesState(s, { kind: "add", text: "  " }), false);
  assert.equal(opChangesState(s, { kind: "remove", index: 5 }), false);
  assert.equal(opChangesState(s, { kind: "remove", index: -1 }), false);
  assert.equal(opChangesState(s, { kind: "move", from: 0, to: 0 }), false);
  // single-item queue: move clamps to the same index -> no-op
  const single = createMagazineState();
  assert.equal(opChangesState(pushStash(single, "only").state, { kind: "move", from: 0, to: 1 }), false);
  // clear on a non-empty queue IS a change; on an empty queue it is a no-op
  assert.equal(opChangesState(s, { kind: "clear" }), true);
  assert.equal(opChangesState(createMagazineState(), { kind: "clear" }), false);
  assert.equal(opChangesState(s, { kind: "remove", index: 0 }), true);
  assert.equal(opChangesState(s, { kind: "move", from: 0, to: 1 }), true);
  assert.equal(opChangesState(s, { kind: "add", text: "x" }), true);
});

test("replayMagazine: replays a pure op log from empty", () => {
  const records = [
    serializeOp({ kind: "add", text: "a" }),
    serializeOp({ kind: "add", text: "b" }),
    serializeOp({ kind: "add", text: "c" }),
    serializeOp({ kind: "remove", index: 1 }),
  ];
  const s = replayMagazine(records);
  assert.deepEqual(s.queue.map((e) => e.text), ["a", "c"]);
});

test("replayMagazine: uses the LAST snapshot anchor and replays ops after it", () => {
  const records = [
    serializeOp({ kind: "add", text: "pre-snapshot" }),
    serializeSnapshot(createMagazineState()), // empty snapshot
    serializeOp({ kind: "add", text: "a" }),
    serializeOp({ kind: "add", text: "b" }),
    serializeOp({ kind: "move", from: 1, to: 0 }),
    serializeOp({ kind: "remove", index: 1 }),
  ];
  const s = replayMagazine(records);
  assert.deepEqual(s.queue.map((e) => e.text), ["b"]);
});

test("replayMagazine: legacy full snapshots {queue:[...]} are recognized", () => {
  const s1 = createMagazineState();
  const legacy = { queue: [{ id: "x", text: "legacy-a", createdAt: 1 }, { id: "y", text: "legacy-b", createdAt: 2 }] };
  const s = replayMagazine([legacy, serializeOp({ kind: "remove", index: 0 })]);
  assert.deepEqual(s.queue.map((e) => e.text), ["legacy-b"]);
  // and a legacy snapshot with no ops at all
  const s2 = replayMagazine([legacy]);
  assert.deepEqual(s2.queue.map((e) => e.text), ["legacy-a", "legacy-b"]);
});

test("replayMagazine: skips malformed records without throwing", () => {
  const records = [
    null,
    "garbage",
    { v: 2, kind: "add" }, // missing text
    serializeOp({ kind: "add", text: "ok" }),
    42,
  ];
  const s = replayMagazine(records);
  assert.deepEqual(s.queue.map((e) => e.text), ["ok"]);
});

test("replayMagazine: empty records yield an empty queue", () => {
  assert.equal(countMagazine(replayMagazine([])), 0);
  assert.equal(countMagazine(replayMagazine([null, undefined])), 0);
});

test("SNAPSHOT_EVERY is a sane anchor cadence", () => {
  assert.ok(SNAPSHOT_EVERY >= 10 && SNAPSHOT_EVERY <= 100);
});
