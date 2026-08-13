import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import unifiedEdit, { __test } from "../unified-edit.ts";

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

type TestMode = "rows" | "patch" | "code" | "pi";

async function runEdit(cwd: string, text: string, mode: TestMode = "patch"): Promise<ExecuteResult> {
	const prev = process.env.PI_UNIFIED_EDIT_MODE;
	process.env.PI_UNIFIED_EDIT_MODE = mode;
	const definition = registerTool();
	const params = (definition.prepareArguments as (args: unknown) => any)({ text });
	try {
		return await definition.execute("regression-call", params, undefined, undefined, { cwd } as any);
	} finally {
		if (prev === undefined) delete process.env.PI_UNIFIED_EDIT_MODE;
		else process.env.PI_UNIFIED_EDIT_MODE = prev;
	}
}

async function runEditError(cwd: string, text: string, mode: TestMode = "patch"): Promise<Error> {
	try {
		await runEdit(cwd, text, mode);
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
	throw new Error(`expected runEdit to reject, but it succeeded: ${text}`);
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-unified-edit-reg-"));
}

// ============================================================================
// A. Parser strictness (P0-1)
// ============================================================================

test("A1: space-prefixed [app] as first @REPLACE context row matches, no phantom file", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "[app]\nname = x\n");
		const result = await runEdit(root, ["[cfg.txt]", "@REPLACE", " [app]", "-name = x", "+name = y"].join("\n"), "rows");
		assert.match(resultTextOf(result), /Edited cfg\.txt/);
		assert.equal(readFileSync(join(root, "cfg.txt"), "utf8"), "[app]\nname = y\n");
		assert.equal(existsSync(join(root, "app")), false, "no phantom file must be created");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A2: space-prefixed [app] as mid-hunk context row participates in matching", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "name = x\n[app]\n");
		await runEdit(root, ["[cfg.txt]", "@REPLACE", "-name = x", "+name = y", " [app]"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "cfg.txt"), "utf8"), "name = y\n[app]\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A3: regression — a space-prefixed [app] row must never silently edit a file named app", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "old\n");
		writeFileSync(join(root, "app"), "keep\n");
		const err = await runEditError(
			root,
			["[a.txt]", "@REPLACE", "-old", "+new", " [app]", "@APPEND", "+touched"].join("\n"),
			"rows",
		);
		assert.match(err.message, /Could not find|no \+ or - rows/);
		// Atomic: neither file may be modified.
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "old\n");
		assert.equal(readFileSync(join(root, "app"), "utf8"), "keep\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A4: indented [path] header is a parse error mentioning column 0", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "keep.txt"), "keep\n");
		const err = await runEditError(root, ["  [b.txt]", "@APPEND", "+x"].join("\n"), "rows");
		assert.match(err.message, /invalid row script line/);
		assert.match(err.message, /column 0/);
		assert.equal(existsSync(join(root, "b.txt")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A5: header with trailing spaces still works", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "b.txt"), "base\n");
		await runEdit(root, ["[b.txt]   ", "@APPEND", "+x"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "base\nx\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A6: bracket content works via -/+ rows", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "g.txt"), "[app]\nkeep\n");
		await runEdit(root, ["[g.txt]", "@REPLACE", "-[app]", "+[app]", "-keep", "+kept"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "g.txt"), "utf8"), "[app]\nkept\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A7: stray @@ outside @REPLACE is a parse error", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@@", "@APPEND", "+y"].join("\n"), "rows");
		assert.match(err.message, /'@@' is only valid inside @REPLACE/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A8: bare empty - row is a parse error with line number", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-", "+y"].join("\n"), "rows");
		assert.match(err.message, /Line 3: - rows in @REPLACE\/@INS\.BEFORE\/@INS\.AFTER must not be empty/);
		assert.match(err.message, /use @DEL N/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A9: context rows under @INS.BEFORE/@INS.AFTER are parse errors", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "anchor\n");
		const err = await runEditError(root, ["[f.txt]", "@INS.AFTER", "-anchor", " [app]", "+x"].join("\n"), "rows");
		assert.match(err.message, /context rows are only supported in @REPLACE/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "anchor\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A10: context-only @REPLACE hunk errors with the can't-locate hint", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "alpha\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", " alpha"].join("\n"), "rows");
		assert.match(err.message, /has no \+ or - rows/);
		assert.match(err.message, /context-only hunk cannot locate a change/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A11: empty @REPLACE errors with the bracket-content hint", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE"].join("\n"), "rows");
		assert.match(err.message, /has no \+ or - rows/);
		assert.match(err.message, /file headers start at column 0/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A12: @-escaped header path is stripped, not resolved literally", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "weird.txt"), "x\n");
		await runEdit(root, ["[@weird.txt]", "@REPLACE", "-x", "+y"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "weird.txt"), "utf8"), "y\n");
		assert.equal(existsSync(join(root, "@weird.txt")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// B. Matching semantics (locked behavior)
// ============================================================================

test("B1: whitespace-only - row does not hang and errors cleanly", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "w.txt"), "x\n");
		const err = await runEditError(root, ["[w.txt]", "@REPLACE", "- ", "+y"].join("\n"), "rows");
		assert.match(err.message, /Could not find/);
		writeFileSync(join(root, "w.txt"), "x  \n");
		const err2 = await runEditError(root, ["[w.txt]", "@REPLACE", "-  ", "+y"].join("\n"), "rows");
		assert.match(err2.message, /Could not find/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B2: fuzzy normalization matches curly quotes", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "q.txt"), "don't stop\n");
		await runEdit(root, ["[q.txt]", "@REPLACE", "-don’t stop", "+don't go"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "q.txt"), "utf8"), "don't go\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B3: internal whitespace is NOT fuzzy — port=8080 does not match port = 8080", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "port = 8080\n");
		const err = await runEditError(root, ["[cfg.txt]", "@REPLACE", "-port=8080", "+port=9090"].join("\n"), "rows");
		assert.match(err.message, /Could not find/);
		assert.equal(readFileSync(join(root, "cfg.txt"), "utf8"), "port = 8080\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B4: partial-line needles are rejected (whole-line matching)", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "c.txt"), "cat\n");
		const err = await runEditError(root, ["[c.txt]", "@REPLACE", "-a", "+b"].join("\n"), "rows");
		assert.match(err.message, /Could not find/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B5: duplicate anchors report occurrence line numbers", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "dup.txt"), "name = x\nname = x\nname = y\n");
		const err = await runEditError(root, ["[dup.txt]", "@REPLACE", "-name = x", "+name = z"].join("\n"), "rows");
		assert.match(err.message, /Found 2 occurrences/);
		assert.match(err.message, /occurring at lines 1, 2/);
		assert.match(err.message, /Provide more context/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B6: overlapping hunks in one @REPLACE are rejected", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "o.txt"), "a\nb\nc\n");
		const err = await runEditError(
			root,
			["[o.txt]", "@REPLACE", "-a", "-b", "+A", "+B", "@@", "-b", "-c", "+B2", "+C"].join("\n"),
			"rows",
		);
		assert.match(err.message, /overlap/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B7: odd +/- block count is rejected", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "a\nb\nc\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-a", "+b", "-c"].join("\n"), "rows");
		assert.match(err.message, /odd number/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B8: @DEL/@INS.PRE are sequential; out-of-range @DEL errors", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "seq.txt"), "one\ntwo\nthree\nfour\nfive\n");
		await runEdit(root, ["[seq.txt]", "@DEL 2-3", "@INS.PRE 2", "+ins"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "seq.txt"), "utf8"), "one\nins\nfour\nfive\n");
		const err = await runEditError(root, ["[seq.txt]", "@DEL 9"].join("\n"), "rows");
		assert.match(err.message, /@DEL 9-9 is outside seq\.txt/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B9: @APPEND to a file without trailing newline inserts the newline", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "t.txt"), "tail");
		await runEdit(root, ["[t.txt]", "@APPEND", "+more"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "t.txt"), "utf8"), "tail\nmore\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B10: CRLF line endings are preserved", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\n");
		await runEdit(root, ["[crlf.txt]", "@REPLACE", "-a", "+A"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "crlf.txt"), "utf8"), "A\r\nb\r\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B11: BOM is preserved", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "bom.txt"), "\uFEFFx\n");
		await runEdit(root, ["[bom.txt]", "@APPEND", "+y"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "bom.txt"), "utf8"), "\uFEFFx\ny\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// C. Diagnostics (P0-2)
// ============================================================================

test("C1: match failure names the op ordinal, block index and row content", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "port = 8080\n");
		const err = await runEditError(
			root,
			["[cfg.txt]", "@REPLACE", "-port = 8080", "+port = 9090", "@REPLACE", "-nope", "+yep"].join("\n"),
			"rows",
		);
		assert.match(err.message, /Failed @REPLACE op 2, block 1\/1/);
		assert.match(err.message, /"nope"/);
		assert.match(err.message, /Tip: the diff-style separator \(one leading space after a marker\) is already tried automatically/);
		assert.equal(readFileSync(join(root, "cfg.txt"), "utf8"), "port = 8080\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C2: update drift between preflight and apply fails with a clear guard error", async () => {
	const root = tempDir();
	try {
		const f = join(root, "d.txt");
		writeFileSync(f, "one\ntwo\n");
		const change = {
			kind: "update",
			path: "d.txt",
			absolutePath: f,
			oldText: "one\ntwo\n",
			newText: "one\ntwo\nthree\n",
		} as any;
		writeFileSync(f, "one\nCHANGED\n"); // drift after plan/preflight
		await assert.rejects(
			__test.applyUpdateChange(change, undefined),
			/file content changed since preflight \(expected 8 chars, found 12 chars\)/,
		);
		assert.equal(readFileSync(f, "utf8"), "one\nCHANGED\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("C3: error payload is bounded (rows truncated)", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const longRow = "a".repeat(200);
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", `-${longRow}`, "+b"].join("\n"), "rows");
		assert.match(err.message, /Failed @REPLACE op 1, block 1\/1/);
		assert.match(err.message, /No changes were applied/);
		assert.ok(err.message.length < 700, `error message too long (${err.message.length}): ${err.message}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// D. Atomicity (P1-4)
// ============================================================================

test("D1: mid-apply failure rolls back earlier changes (best-effort)", async (t) => {
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		t.skip("root bypasses directory permissions");
		return;
	}
	const root = tempDir();
	const locked = join(root, "locked");
	try {
		mkdirSync(locked);
		writeFileSync(join(locked, "del.txt"), "bye\n");
		writeFileSync(join(root, "keep.txt"), "keep\n");
		chmodSync(locked, 0o555);
		const err = await runEditError(
			root,
			["*** Begin Patch", "*** Add File: new.txt", "+hello", "*** Delete File: locked/del.txt", "*** End Patch"].join("\n"),
			"patch",
		);
		assert.match(err.message, /Applied 1 of 2 change\(s\) before failure/);
		assert.equal(existsSync(join(root, "new.txt")), false, "added file must be rolled back");
		assert.equal(readFileSync(join(locked, "del.txt"), "utf8"), "bye\n");
		assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep\n");
	} finally {
		chmodSync(locked, 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

test("D2: abort before any mutation leaves files untouched and reports 0 applied", async () => {
	const root = tempDir();
	try {
		const f = join(root, "a.txt");
		writeFileSync(f, "x\n");
		const change = { kind: "update", path: "a.txt", absolutePath: f, oldText: "x\n", newText: "y\n" } as any;
		await assert.rejects(
			__test.applyPlan({ mode: "rows", changes: [change] } as any, { aborted: true } as AbortSignal),
			/Operation aborted/,
		);
		assert.equal(readFileSync(f, "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function resultTextOf(result: ExecuteResult): string {
	return result.content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => (item as { type: "text"; text: string }).text)
		.join("\n");
}

// ============================================================================
// E. Diff-style separator tolerance (unified-diff alignment)
// ============================================================================

test("E1: diff-style - row ('- Line two.') matches on first try", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "Line one.\nLine two.\n");
		await runEdit(root, ["[d.txt]", "@REPLACE", "- Line two.", "+ Line two (replaced)."].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "Line one.\nLine two (replaced).\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E2: diff-style anchor ('- Line one.') matches and never writes the separator back", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "Line one.\n");
		await runEdit(root, ["[d.txt]", "@INS.AFTER", "- Line one.", "+x"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "Line one.\nx\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E3: adjacent style with indented content still matches exactly", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "pkg.json"), '{\n  "version": "1.0.0",\n}\n');
		await runEdit(root, ["[pkg.json]", "@REPLACE", '-  "version": "1.0.0",', '+  "version": "1.0.1",'].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "pkg.json"), "utf8"), '{\n  "version": "1.0.1",\n}\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E4: two-space row content falls back to the one-space file line", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), " foo\n");
		await runEdit(root, ["[d.txt]", "@REPLACE", "-  foo", "+bar"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "bar\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E5: stripped variant with multiple matches is rejected as ambiguous", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), " a\n a\n");
		const err = await runEditError(root, ["[d.txt]", "@REPLACE", "-  a", "+b"].join("\n"), "rows");
		assert.match(err.message, /Found 2 occurrences/);
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), " a\n a\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E6: a space-only row is a blank context row", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "alpha\n\nbeta\n");
		await runEdit(root, ["[d.txt]", "@REPLACE", " alpha", " ", "-beta", "+BETA"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "alpha\n\nBETA\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E7: + rows insert content verbatim (no separator stripping)", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "x\n");
		await runEdit(root, ["[d.txt]", "@APPEND", "+ y"].join("\n"), "rows");
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "x\n y\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E8: stripped context and + rows are not re-written with the separator space", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "a\nb\n");
		await runEdit(root, ["[d.txt]", "@REPLACE", "  a", "- b", "+ B"].join("\n"), "rows");
		// Row "  a" = context " a" (exact fails on "a\nb"); stripped variant
		// matches "a\nb" and must NOT re-write context or + rows with their
		// separator spaces.
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "a\nB\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E9: whitespace-only - row still errors without hanging or empty-needle noise", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "w.txt"), "x\n");
		const err = await runEditError(root, ["[w.txt]", "@REPLACE", "- ", "+y"].join("\n"), "rows");
		assert.match(err.message, /Could not find/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// F. Non-UTF-8 / binary file rejection (0.1.1)
// ============================================================================

function binaryBytes(): Buffer {
	// "bin\n" + NUL + three invalid bytes + "bin\n" — the invalid sequence
	// 0xFF 0xFE 0x80 must never be touched, even by an edit to another line.
	return Buffer.from([0x62, 0x69, 0x6e, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x62, 0x69, 0x6e, 0x0a]);
}

test("F1: @REPLACE on an invalid-UTF-8 file errors and leaves bytes untouched", async () => {
	const root = tempDir();
	try {
		const f = join(root, "bin.dat");
		const bytes = binaryBytes();
		writeFileSync(f, bytes);
		const err = await runEditError(root, ["[bin.dat]", "@REPLACE", "-bin", "+BIN"].join("\n"), "rows");
		assert.match(err.message, /not valid UTF-8/);
		assert.match(err.message, /Refusing to edit/);
		assert.deepEqual(readFileSync(f), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("F2: @APPEND on an invalid-UTF-8 file errors and leaves bytes untouched", async () => {
	const root = tempDir();
	try {
		const f = join(root, "bin.dat");
		const bytes = binaryBytes();
		writeFileSync(f, bytes);
		const err = await runEditError(root, ["[bin.dat]", "@APPEND", "+tail"].join("\n"), "rows");
		assert.match(err.message, /not valid UTF-8/);
		assert.deepEqual(readFileSync(f), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("F3: patch-mode Update File on an invalid-UTF-8 file errors", async () => {
	const root = tempDir();
	try {
		const f = join(root, "bin.dat");
		const bytes = binaryBytes();
		writeFileSync(f, bytes);
		const err = await runEditError(
			root,
			["*** Begin Patch", "*** Update File: bin.dat", "@@ bin", "-bin", "+BIN", "*** End Patch"].join("\n"),
			"patch",
		);
		assert.match(err.message, /not valid UTF-8/);
		assert.deepEqual(readFileSync(f), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("F4: multi-file row script with one invalid-UTF-8 target is rejected atomically", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "good.txt"), "keep\n");
		const f = join(root, "bin.dat");
		const bytes = binaryBytes();
		writeFileSync(f, bytes);
		const err = await runEditError(
			root,
			["[good.txt]", "@REPLACE", "-keep", "+KEPT", "[bin.dat]", "@APPEND", "+tail"].join("\n"),
			"rows",
		);
		assert.match(err.message, /not valid UTF-8/);
		// The valid target must not have been touched either.
		assert.equal(readFileSync(join(root, "good.txt"), "utf8"), "keep\n");
		assert.deepEqual(readFileSync(f), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("F5: valid UTF-8 containing NUL bytes remains editable (only invalid sequences are rejected)", async () => {
	const root = tempDir();
	try {
		const f = join(root, "nul.txt");
		// NUL (0x00) is valid UTF-8; only malformed sequences are rejected.
		writeFileSync(f, Buffer.from([0x61, 0x0a, 0x00, 0x62, 0x0a]));
		await runEdit(root, ["[nul.txt]", "@REPLACE", "-a", "+A"].join("\n"), "rows");
		assert.deepEqual(readFileSync(f), Buffer.from([0x41, 0x0a, 0x00, 0x62, 0x0a]));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("F6: apply-phase strict read rejects invalid UTF-8 (last line of defense)", async () => {
	const root = tempDir();
	try {
		const f = join(root, "bin.dat");
		const bytes = binaryBytes();
		writeFileSync(f, bytes);
		// Directly exercise the mutation-phase read (plan building normally
		// rejects the file first, so this pins the apply-phase guard too).
		const lossy = bytes.toString("utf-8");
		await assert.rejects(
			__test.applyUpdateChange({
				path: "bin.dat",
				absolutePath: f,
				kind: "update",
				oldText: lossy,
				newText: lossy.replace("bin", "BIN"),
			}),
			/not valid UTF-8/,
		);
		assert.deepEqual(readFileSync(f), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// G. Failure diagnostics (0.1.1 follow-up: all-or-nothing + format hints)
// ============================================================================

test("G1: multi-op match failure states that no changes were applied", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "port = 8080\n");
		const err = await runEditError(
			root,
			["[cfg.txt]", "@REPLACE", "-port = 8080", "+port = 9090", "@REPLACE", "-nope", "+yep"].join("\n"),
			"rows",
		);
		assert.match(err.message, /No changes were applied — the payload is all-or-nothing/);
		assert.equal(readFileSync(join(root, "cfg.txt"), "utf8"), "port = 8080\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("G2: parse error also states that no changes were applied", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-", "+b"].join("\n"), "rows");
		assert.match(err.message, /No changes were applied — the payload is all-or-nothing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("G3: unmatched row with different leading format names the similar file line", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "AGENTS.md"), "## Checklist\n4. Native xAI: check the provider.\n5. Done.\n");
		// The model wrote a bullet-style row for a numbered item: body "-4. ..."
		const err = await runEditError(root, ["[AGENTS.md]", "@REPLACE", "--4. Native xAI: check the provider.", "+removed"].join("\n"), "rows");
		assert.match(err.message, /Failed @REPLACE op 1, block 1\/1/);
		assert.match(err.message, /similar line with different leading format/);
		assert.match(err.message, /4\. Native xAI: check the provider/);
		assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "## Checklist\n4. Native xAI: check the provider.\n5. Done.\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("G4: indentation mismatch names the similar indented file line", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "code.py"), "def f():\n    pass\n");
		// Row without the leading indentation; the file line is indented.
		const err = await runEditError(root, ["[code.py]", "@REPLACE", "-pass", "+pass  # ok"].join("\n"), "rows");
		assert.match(err.message, /Failed @REPLACE op 1, block 1\/1/);
		assert.match(err.message, /similar line with different leading format/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// H. Code mode (dual-track: js: / ```js payloads)
// ============================================================================

test("H1: js: prefix replaces a value via readFile/writeFile", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "name = x\nport = 80\n");
		const result = await runEdit(
			root,
			[
				"js:",
				'const s = readFile("cfg.txt");',
				'writeFile("cfg.txt", s.replace("name = x", "name = y"));',
			].join("\n"),
			"code",
		);
		assert.equal(readFileSync(join(root, "cfg.txt"), "utf8"), "name = y\nport = 80\n");
		assert.match(resultTextOf(result), /Edited/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H2: ```js fence payload works", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "alpha\n");
		await runEdit(root, ["```js", 'writeFile("a.txt", readFile("a.txt").toUpperCase());', "```"].join("\n"), "code");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "ALPHA\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H3: exception rolls back every writeFile of the call", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "one\n");
		writeFileSync(join(root, "b.txt"), "two\n");
		const err = await runEditError(
			root,
			["js:", 'writeFile("a.txt", "CHANGED-A");', 'writeFile("b.txt", "CHANGED-B");', 'throw new Error("boom");'].join("\n"),
			"code",
		);
		assert.match(err.message, /Code mode failed/);
		assert.match(err.message, /rolled back/);
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n");
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "two\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H4: new files are created and removed on rollback", async () => {
	const root = tempDir();
	try {
		const err = await runEditError(
			root,
			["js:", 'writeFile("new.txt", "fresh");', 'throw new Error("boom");'].join("\n"),
			"code",
		);
		assert.match(err.message, /Code mode failed/);
		assert.equal(existsSync(join(root, "new.txt")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H5: multiple writes to one file keep the last content", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		await runEdit(root, ["js:", 'writeFile("f.txt", "first");', 'writeFile("f.txt", "second");'].join("\n"), "code");
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "second");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H6: syntax error is rejected before any execution", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["js:", "writeFile('f.txt', 'nope';"].join("\n"), "code");
		assert.match(err.message, /Code mode syntax error/);
		assert.match(err.message, /No changes were applied/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H7: readFile refuses non-UTF-8 files", async () => {
	const root = tempDir();
	try {
		const f = join(root, "bin.dat");
		writeFileSync(f, Buffer.from([0x62, 0x69, 0x6e, 0x00, 0xff, 0xfe]));
		const err = await runEditError(root, ["js:", 'const s = readFile("bin.dat");'].join("\n"), "code");
		assert.match(err.message, /Code mode failed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("H8: no writeFile call reports no changes", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "x\n");
		const err = await runEditError(root, ["js:", 'const s = readFile("cfg.txt");'].join("\n"), "code");
		assert.match(err.message, /did not call writeFile/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// I. Single-mode selection (PI_UNIFIED_EDIT_MODE) — one dialect per process
// ============================================================================

test("I1: rows mode rejects apply-patch and js: payloads with a clear hint", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["*** Begin Patch", "*** Update File: f.txt", "@@ x", "-x", "+y", "*** End Patch"].join("\n"), "rows");
		assert.match(err.message, /configured for row-script mode/);
		assert.match(err.message, /PI_UNIFIED_EDIT_MODE/);
		const err2 = await runEditError(root, ["js:", 'writeFile("f.txt", "y");'].join("\n"), "rows");
		assert.match(err2.message, /configured for row-script mode/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("I2: patch mode rejects row scripts and js: payloads with a clear hint", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-x", "+y"].join("\n"), "patch");
		assert.match(err.message, /configured for patch mode/);
		assert.match(err.message, /Begin Patch/);
		const err2 = await runEditError(root, ["js:", 'writeFile("f.txt", "y");'].join("\n"), "patch");
		assert.match(err2.message, /configured for patch mode/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("I3: code mode rejects row scripts and patches with a clear hint", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-x", "+y"].join("\n"), "code");
		assert.match(err.message, /configured for code mode/);
		assert.match(err.message, /js:/);
		const err2 = await runEditError(
			root,
			["*** Begin Patch", "*** Update File: f.txt", "@@ x", "-x", "+y", "*** End Patch"].join("\n"),
			"code",
		);
		assert.match(err2.message, /configured for code mode/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "x\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("I4: patch mode still works end-to-end when selected", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "old.txt"), "alpha\nbeta\ngamma\n");
		await runEdit(
			root,
			["*** Begin Patch", "*** Update File: old.txt", "@@ alpha", "-beta", "+BETA", "*** End Patch"].join("\n"),
			"patch",
		);
		assert.equal(readFileSync(join(root, "old.txt"), "utf8"), "alpha\nBETA\ngamma\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("I5: code mode still works end-to-end when selected", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		await runEdit(root, ["js:", 'writeFile("f.txt", "y");'].join("\n"), "code");
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "y");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// J. Unified-diff compatibility (post-trained model habits)
// ============================================================================

test("J1: standard unified-diff line-range header (@@ -1 +1 @@) is accepted", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "hdr.txt"), "keep me\n");
		await runEdit(
			root,
			["*** Begin Patch", "*** Update File: hdr.txt", "@@ -1 +1 @@", "-keep me", "+kept", "*** End Patch"].join("\n"),
			"patch",
		);
		assert.equal(readFileSync(join(root, "hdr.txt"), "utf8"), "kept\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("J2: comma-range header (@@ -2,3 +1,4 @@) is accepted", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "r.txt"), "a\nb\nc\n");
		await runEdit(
			root,
			["*** Begin Patch", "*** Update File: r.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "*** End Patch"].join("\n"),
			"patch",
		);
		assert.equal(readFileSync(join(root, "r.txt"), "utf8"), "a\nB\nc\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("J3: real change-context (@@ with trailing text) still works", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "ctx.txt"), "alpha\nbeta\n");
		await runEdit(
			root,
			["*** Begin Patch", "*** Update File: ctx.txt", "@@ alpha", "-beta", "+BETA", "*** End Patch"].join("\n"),
			"patch",
		);
		assert.equal(readFileSync(join(root, "ctx.txt"), "utf8"), "alpha\nBETA\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ============================================================================
// K. Pi mode (native JSON payload: {path, edits:[{oldText,newText}]})
// ============================================================================

test("K1: pi-mode JSON payload replaces substrings", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "name = x\nport = 80\n");
		await runEdit(root, JSON.stringify({ path: "a.txt", edits: [{ oldText: "name = x", newText: "name = y" }] }), "pi");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "name = y\nport = 80\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("K2: pi-mode multi-file array form", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "alpha\n");
		writeFileSync(join(root, "b.txt"), "beta\n");
		const payload = JSON.stringify([
			{ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] },
			{ path: "b.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
		]);
		await runEdit(root, payload, "pi");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "ALPHA\n");
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "BETA\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("K3: pi-mode substring edits apply in order per file", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "s.txt"), "abc\n");
		const payload = JSON.stringify({
			path: "s.txt",
			edits: [
				{ oldText: "abc", newText: "abXc" },
				{ oldText: "Xc", newText: "XYc" },
			],
		});
		await runEdit(root, payload, "pi");
		assert.equal(readFileSync(join(root, "s.txt"), "utf8"), "abXYc\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("K4: pi-mode one failed edit applies nothing (all-or-nothing)", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "keep\n");
		const payload = JSON.stringify({
			path: "a.txt",
			edits: [
				{ oldText: "keep", newText: "KEPT" },
				{ oldText: "does-not-exist", newText: "x" },
			],
		});
		const err = await runEditError(root, payload, "pi");
		assert.match(err.message, /No changes were applied/);
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "keep\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("K5: pi-mode rejects invalid JSON, empty oldText, and missing files", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "x\n");
		const err1 = await runEditError(root, "{not json", "pi");
		assert.match(err1.message, /invalid JSON/);
		const err2 = await runEditError(root, JSON.stringify({ path: "a.txt", edits: [{ oldText: "", newText: "y" }] }), "pi");
		assert.match(err2.message, /oldText must not be empty/);
		const err3 = await runEditError(root, JSON.stringify({ path: "nope.txt", edits: [{ oldText: "x", newText: "y" }] }), "pi");
		assert.match(err3.message, /Could not read|ENOENT/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("K6: pi mode rejects non-pi payloads with a clear hint", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-x", "+y"].join("\n"), "pi");
		assert.match(err.message, /configured for pi mode/);
		const err2 = await runEditError(
			root,
			["*** Begin Patch", "*** Update File: f.txt", "@@ x", "-x", "+y", "*** End Patch"].join("\n"),
			"pi",
		);
		assert.match(err2.message, /configured for pi mode/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
