import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	diffLines,
	diffWords,
	type DiffStyle,
	renderSideBySide,
	renderUnified,
	sideBySideRows,
} from "../diff.ts";

const plain: DiffStyle = {
	context: (text) => text,
	removed: (text) => text,
	added: (text) => text,
	emphasis: (text) => `[${text}]`,
	lineNumber: (text) => text,
	muted: (text) => text,
	title: (text) => text,
};

const ansi: DiffStyle = {
	...plain,
	removed: (text) => `\u001b[31m${text}\u001b[39m`,
	added: (text) => `\u001b[32m${text}\u001b[39m`,
	emphasis: (text) => `\u001b[7m${text}\u001b[27m`,
};

const options = { leftTitle: "before", rightTitle: "after", leftPlaceholder: "(new)", rightPlaceholder: "(removed)" };

describe("line diff", () => {
	test("aligns unchanged lines and numbers each side independently", () => {
		const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
		assert.deepEqual(ops.map((op) => op.kind), ["same", "removed", "added", "same", "same", "added"]);
		const added = ops.at(-1);
		assert.equal(added?.kind === "added" ? added.right.line : 0, 5);
	});

	test("pairs replaced runs and folds long unchanged runs", () => {
		const before = Array.from({ length: 30 }, (_v, i) => `line ${i + 1}`).join("\n");
		const after = before.replace("line 15", "line fifteen");
		const rows = sideBySideRows(diffLines(before, after), 2);
		assert.deepEqual(rows.map((row) => row.kind), ["skipped", "same", "same", "changed", "same", "same", "skipped"]);
		assert.equal(rows[0]?.kind === "skipped" ? rows[0].count : 0, 12);
		assert.equal(rows[3]?.kind === "changed" ? `${rows[3].left.line}/${rows[3].right.line}` : "", "15/15");
	});

	test("identical text has no rows", () => {
		assert.deepEqual(sideBySideRows(diffLines("same\ntext", "same\ntext")), []);
	});

	test("falls back to a replaced block instead of an unbounded table", () => {
		const before = Array.from({ length: 1_500 }, (_v, i) => `old ${i}`).join("\n");
		const after = Array.from({ length: 1_500 }, (_v, i) => `new ${i}`).join("\n");
		const ops = diffLines(before, after);
		assert.equal(ops.filter((op) => op.kind === "removed").length, 1_500);
		assert.equal(ops.filter((op) => op.kind === "added").length, 1_500);
	});
});

describe("word diff", () => {
	test("marks only the changed words of a changed pair", () => {
		const { left, right } = diffWords("estimated tokens 27779 to budget", "estimated tokens 27777 to budget");
		assert.deepEqual(left.filter((span) => span.changed).map((span) => span.text), ["27779"]);
		assert.deepEqual(right.filter((span) => span.changed).map((span) => span.text), ["27777"]);
	});
});

describe("side-by-side rendering", () => {
	test("wraps real removal placeholders without breaking the column boundary", () => {
		for (const width of [60, 61, 64, 70]) {
			const lines = renderSideBySide(sideBySideRows(diffLines("deleted", "")), width, ansi, {
				...options, rightPlaceholder: "(removed from the next request)",
			});
			assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
			assert.match(lines.join("\n"), /removed from/);
		}
	});

	test("puts before and after in two columns with change markers", () => {
		const rows = sideBySideRows(diffLines("keep\nold value\ngone", "keep\nnew value\nextra"));
		const lines = renderSideBySide(rows, 80, plain, options);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
		assert.match(lines[0] ?? "", /^before\s+│ after/);
		assert.match(lines[1] ?? "", /┼/);
		const changed = lines.find((line) => line.includes("[old]"));
		assert.match(changed ?? "", /\[old\] value\s+~ 2 \[new\] value/);
		assert.match(lines.join("\n"), /3 \[gone\]\s+~ 3 \[extra\]/);
	});

	test("wraps long lines inside their own column and fills the empty side", () => {
		const rows = sideBySideRows(diffLines("x ".repeat(60).trim(), ""));
		const lines = renderSideBySide(rows, 70, plain, options);
		assert.ok(lines.length > 4, "the long removed line wraps onto several rows");
		assert.ok(lines.every((line) => visibleWidth(line) <= 70));
		assert.match(lines[2] ?? "", /−\s+\(removed\)/);
	});

	test("closes open styles at column edges so emphasis does not bleed", () => {
		const rows = sideBySideRows(diffLines(`${"word ".repeat(20)}old`, `${"word ".repeat(20)}new`));
		const lines = renderSideBySide(rows, 60, ansi, options);
		assert.ok(lines.every((line) => visibleWidth(line) <= 60));
		for (const line of lines.slice(2)) {
			const marker = line.search(/[~│]/);
			if (marker < 0) continue;
			const left = line.slice(0, marker);
			if (left.includes("\u001b[31m")) assert.ok(left.includes("\u001b[0m"), `left column closed: ${JSON.stringify(left)}`);
		}
	});

	test("unified fallback uses Pi's -/+ convention", () => {
		const rows = sideBySideRows(diffLines("a\nold", "a\nnew"));
		const lines = renderUnified(rows, 40, plain, options);
		assert.equal(lines[0], "before → after");
		assert.ok(lines.includes(" 1 a"));
		assert.ok(lines.includes("-2 [old]"));
		assert.ok(lines.includes("+2 [new]"));
	});
});
