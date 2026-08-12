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

async function runEdit(cwd: string, text: string): Promise<ExecuteResult> {
	const definition = registerTool();
	const params = (definition.prepareArguments as (args: unknown) => any)({ text });
	return definition.execute("regression-call", params, undefined, undefined, { cwd } as any);
}

async function runEditError(cwd: string, text: string): Promise<Error> {
	try {
		await runEdit(cwd, text);
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
		const result = await runEdit(root, ["[cfg.txt]", "@REPLACE", " [app]", "-name = x", "+name = y"].join("\n"));
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
		await runEdit(root, ["[cfg.txt]", "@REPLACE", "-name = x", "+name = y", " [app]"].join("\n"));
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
		const err = await runEditError(root, ["  [b.txt]", "@APPEND", "+x"].join("\n"));
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
		await runEdit(root, ["[b.txt]   ", "@APPEND", "+x"].join("\n"));
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "base\nx\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A6: bracket content works via -/+ rows", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "g.txt"), "[app]\nkeep\n");
		await runEdit(root, ["[g.txt]", "@REPLACE", "-[app]", "+[app]", "-keep", "+kept"].join("\n"));
		assert.equal(readFileSync(join(root, "g.txt"), "utf8"), "[app]\nkept\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("A7: stray @@ outside @REPLACE is a parse error", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "x\n");
		const err = await runEditError(root, ["[f.txt]", "@@", "@APPEND", "+y"].join("\n"));
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
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-", "+y"].join("\n"));
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
		const err = await runEditError(root, ["[f.txt]", "@INS.AFTER", "-anchor", " [app]", "+x"].join("\n"));
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
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", " alpha"].join("\n"));
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
		const err = await runEditError(root, ["[f.txt]", "@REPLACE"].join("\n"));
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
		await runEdit(root, ["[@weird.txt]", "@REPLACE", "-x", "+y"].join("\n"));
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
		const err = await runEditError(root, ["[w.txt]", "@REPLACE", "- ", "+y"].join("\n"));
		assert.match(err.message, /Could not find/);
		writeFileSync(join(root, "w.txt"), "x  \n");
		const err2 = await runEditError(root, ["[w.txt]", "@REPLACE", "-  ", "+y"].join("\n"));
		assert.match(err2.message, /Could not find/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B2: fuzzy normalization matches curly quotes", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "q.txt"), "don't stop\n");
		await runEdit(root, ["[q.txt]", "@REPLACE", "-don’t stop", "+don't go"].join("\n"));
		assert.equal(readFileSync(join(root, "q.txt"), "utf8"), "don't go\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B3: internal whitespace is NOT fuzzy — port=8080 does not match port = 8080", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "cfg.txt"), "port = 8080\n");
		const err = await runEditError(root, ["[cfg.txt]", "@REPLACE", "-port=8080", "+port=9090"].join("\n"));
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
		const err = await runEditError(root, ["[c.txt]", "@REPLACE", "-a", "+b"].join("\n"));
		assert.match(err.message, /Could not find/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B5: duplicate anchors report occurrence line numbers", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "dup.txt"), "name = x\nname = x\nname = y\n");
		const err = await runEditError(root, ["[dup.txt]", "@REPLACE", "-name = x", "+name = z"].join("\n"));
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
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", "-a", "+b", "-c"].join("\n"));
		assert.match(err.message, /odd number/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B8: @DEL/@INS.PRE are sequential; out-of-range @DEL errors", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "seq.txt"), "one\ntwo\nthree\nfour\nfive\n");
		await runEdit(root, ["[seq.txt]", "@DEL 2-3", "@INS.PRE 2", "+ins"].join("\n"));
		assert.equal(readFileSync(join(root, "seq.txt"), "utf8"), "one\nins\nfour\nfive\n");
		const err = await runEditError(root, ["[seq.txt]", "@DEL 9"].join("\n"));
		assert.match(err.message, /@DEL 9-9 is outside seq\.txt/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B9: @APPEND to a file without trailing newline inserts the newline", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "t.txt"), "tail");
		await runEdit(root, ["[t.txt]", "@APPEND", "+more"].join("\n"));
		assert.equal(readFileSync(join(root, "t.txt"), "utf8"), "tail\nmore\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B10: CRLF line endings are preserved", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\n");
		await runEdit(root, ["[crlf.txt]", "@REPLACE", "-a", "+A"].join("\n"));
		assert.equal(readFileSync(join(root, "crlf.txt"), "utf8"), "A\r\nb\r\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B11: BOM is preserved", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "bom.txt"), "\uFEFFx\n");
		await runEdit(root, ["[bom.txt]", "@APPEND", "+y"].join("\n"));
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
		const err = await runEditError(root, ["[f.txt]", "@REPLACE", `-${longRow}`, "+b"].join("\n"));
		assert.match(err.message, /Failed @REPLACE op 1, block 1\/1/);
		assert.ok(err.message.length < 600, `error message too long (${err.message.length}): ${err.message}`);
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
		await runEdit(root, ["[d.txt]", "@REPLACE", "- Line two.", "+ Line two (replaced)."].join("\n"));
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "Line one.\nLine two (replaced).\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E2: diff-style anchor ('- Line one.') matches and never writes the separator back", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "Line one.\n");
		await runEdit(root, ["[d.txt]", "@INS.AFTER", "- Line one.", "+x"].join("\n"));
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "Line one.\nx\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E3: adjacent style with indented content still matches exactly", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "pkg.json"), '{\n  "version": "1.0.0",\n}\n');
		await runEdit(root, ["[pkg.json]", "@REPLACE", '-  "version": "1.0.0",', '+  "version": "1.0.1",'].join("\n"));
		assert.equal(readFileSync(join(root, "pkg.json"), "utf8"), '{\n  "version": "1.0.1",\n}\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E4: two-space row content falls back to the one-space file line", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), " foo\n");
		await runEdit(root, ["[d.txt]", "@REPLACE", "-  foo", "+bar"].join("\n"));
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "bar\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E5: stripped variant with multiple matches is rejected as ambiguous", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), " a\n a\n");
		const err = await runEditError(root, ["[d.txt]", "@REPLACE", "-  a", "+b"].join("\n"));
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
		await runEdit(root, ["[d.txt]", "@REPLACE", " alpha", " ", "-beta", "+BETA"].join("\n"));
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "alpha\n\nBETA\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E7: + rows insert content verbatim (no separator stripping)", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "x\n");
		await runEdit(root, ["[d.txt]", "@APPEND", "+ y"].join("\n"));
		assert.equal(readFileSync(join(root, "d.txt"), "utf8"), "x\n y\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("E8: stripped context and + rows are not re-written with the separator space", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "d.txt"), "a\nb\n");
		await runEdit(root, ["[d.txt]", "@REPLACE", "  a", "- b", "+ B"].join("\n"));
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
		const err = await runEditError(root, ["[w.txt]", "@REPLACE", "- ", "+y"].join("\n"));
		assert.match(err.message, /Could not find/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
