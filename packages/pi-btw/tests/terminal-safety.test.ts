import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeDisplayText } from "../terminal-safety.ts";

test("sanitizeDisplayText strips CSI, OSC, controls, and carriage returns", () => {
  assert.equal(
    sanitizeDisplayText(
      "safe\x1b[31m red\x1b[0m\r\nnext\x1b]52;c;Y2xpcGJvYXJk\x07!\x00\x7f",
    ),
    "safe red\nnext!",
  );
});

test("sanitizeDisplayText preserves tabs, newlines, and valid Unicode", () => {
  assert.equal(sanitizeDisplayText("alpha\tbeta\n中文 😀"), "alpha\tbeta\n中文 😀");
});

test("sanitizeDisplayText drops lone surrogate halves", () => {
  assert.equal(sanitizeDisplayText(`before${String.fromCharCode(0xd800)}after`), "beforeafter");
  assert.equal(sanitizeDisplayText(`before${String.fromCharCode(0xdc00)}after`), "beforeafter");
});
