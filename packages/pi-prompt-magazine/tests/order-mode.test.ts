import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { moveEntry, type StashEntry } from "../magazine.ts";
import { MagazineOrderMode, type MagazineOrderTheme } from "../order-mode.ts";

const plainTheme: MagazineOrderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function entry(id: string, text: string): StashEntry {
  return { id, text, createdAt: 1 };
}

test("order mode starts grabbed, supports release/navigation/reselect, and persists each move", () => {
  let entries = [entry("a", "alpha"), entry("b", "bravo"), entry("c", "charlie")];
  let closed = false;
  const moves: Array<{ id: string; delta: -1 | 1 }> = [];
  const mode = new MagazineOrderMode({
    getEntries: () => entries,
    initialEntryId: "b",
    onMove(id, delta) {
      moves.push({ id, delta });
      const from = entries.findIndex((candidate) => candidate.id === id);
      if (from < 0) return false;
      const next = moveEntry({ queue: entries }, from, from + delta);
      const changed = next.queue !== entries;
      entries = next.queue;
      return changed;
    },
    onClose: () => { closed = true; },
    theme: plainTheme,
  });

  assert.equal(mode.isGrabbed(), true);
  assert.match(mode.render(80)[0], /moving #2/);

  mode.handleInput("\x1b[B"); // Move grabbed b below c.
  assert.deepEqual(entries.map(({ id }) => id), ["a", "c", "b"]);
  assert.equal(mode.getCursorEntryId(), "b");

  mode.handleInput("\r"); // Release b.
  assert.equal(mode.isGrabbed(), false);
  mode.handleInput("\x1b[A"); // Navigate to c without moving b.
  assert.equal(mode.getCursorEntryId(), "c");
  assert.deepEqual(entries.map(({ id }) => id), ["a", "c", "b"]);

  mode.handleInput("\r"); // Grab c.
  mode.handleInput("\x1b[A"); // Move c above a.
  assert.deepEqual(entries.map(({ id }) => id), ["c", "a", "b"]);
  assert.deepEqual(moves, [{ id: "b", delta: 1 }, { id: "c", delta: -1 }]);

  mode.handleInput("\x1b");
  assert.equal(closed, true);
});

test("a concurrently removed grabbed entry is released without moving its replacement", () => {
  let entries = [entry("a", "alpha"), entry("b", "bravo"), entry("c", "charlie")];
  let moveCalls = 0;
  const mode = new MagazineOrderMode({
    getEntries: () => entries,
    initialEntryId: "b",
    onMove() {
      moveCalls += 1;
      return false;
    },
    onClose() {},
    theme: plainTheme,
  });

  entries = [entries[0], entries[2]];
  mode.render(80);
  assert.equal(mode.isGrabbed(), false);
  assert.equal(mode.getCursorEntryId(), "c");
  mode.handleInput("\x1b[A");
  assert.equal(moveCalls, 0);
  assert.equal(mode.getCursorEntryId(), "a");
});

test("order-mode rendering sanitizes previews, windows long queues, and obeys width", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    entry(`id-${index}`, `${"long ".repeat(10)}draft ${index}\u001b]52;c;bad\u0007`),
  );
  const mode = new MagazineOrderMode({
    getEntries: () => entries,
    initialEntryId: "id-10",
    onMove: () => false,
    onClose() {},
    theme: plainTheme,
    maxVisibleRows: 5,
  });

  const lines = mode.render(28);
  assert.ok(lines.some((line) => line.includes("above")));
  assert.ok(lines.some((line) => line.includes("below")));
  assert.ok(lines.some((line) => line.includes("▸ #11")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.ok(lines.every((line) => !line.includes("]52;") && !line.includes("\u0007")));
});
