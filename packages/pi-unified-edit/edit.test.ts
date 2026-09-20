import { initTheme, withFileMutationQueue, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCapabilities, type TerminalCapabilities } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import unifiedEdit, { __test } from "./unified-edit.ts";
import { HashSnapshotStore, hashTag, parseHashPayload, xxHash32 } from "./hash-edit.ts";

type ToolResultHandler = (event: any, ctx: any) => Promise<any> | any;
type CapturedHashExtension = { definition: ToolDefinition<any, any>; toolResult: ToolResultHandler };

// Capability detection reads the host environment (Ghostty, iTerm, kitty, WezTerm and friends
// advertise OSC 8 hyperlinks), so rendered bytes differ per machine. Pin them so render
// assertions match the same output everywhere; the tests that exercise links opt in explicitly.
const HYPERLINKS_OFF: TerminalCapabilities = { images: null, trueColor: false, hyperlinks: false };
const HYPERLINKS_ON: TerminalCapabilities = { images: null, trueColor: false, hyperlinks: true };
setCapabilities(HYPERLINKS_OFF);

function testInDirectory(name: string, run: (root: string) => void | Promise<void>) {
	test(name, async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-unified-edit-"));
		try {
			await run(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

function registerHashExtension(): CapturedHashExtension {
	let definition: ToolDefinition<any, any> | undefined;
	let toolResult: ToolResultHandler | undefined;
	unifiedEdit({
		registerTool(registered: ToolDefinition<any, any>) { definition = registered; },
		on(event: string, handler: ToolResultHandler) {
			if (event === "tool_result") toolResult = handler;
		},
	} as any);
	assert.ok(definition, "extension must register edit");
	assert.equal(definition.name, "edit");
	assert.ok(toolResult, "extension must register a read-result transformer");
	return { definition, toolResult };
}

async function hashRead(
	extension: CapturedHashExtension,
	cwd: string,
	path: string,
	output = readFileSync(join(cwd, path), "utf8"),
	offset = 1,
): Promise<string> {
	const transformed = await extension.toolResult(
		{
			type: "tool_result",
			toolName: "read",
			toolCallId: "read-test",
			input: { path, offset },
			content: [{ type: "text", text: output }],
			details: undefined,
			isError: false,
		},
		{ cwd },
	);
	assert.ok(transformed?.content, "read result should be transformed");
	return transformed.content[0].text;
}

async function executeHash(extension: CapturedHashExtension, cwd: string, text: string): Promise<any> {
	const params = (extension.definition.prepareArguments as (args: unknown) => any)({ text });
	return extension.definition.execute("hash-edit-test", params, undefined, undefined, { cwd } as any);
}

function stripTerminalSequences(text: string): string {
	return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function headerOf(readResult: string): string {
	const header = readResult.split("\n", 1)[0];
	assert.match(header, /^\[.+#[0-9A-F]{4}\]$/);
	return header;
}

async function ready(
	root: string,
	files: Record<string, string | Buffer>,
	read?: Record<string, { output?: string; offset?: number }>,
): Promise<{ extension: CapturedHashExtension; headers: Record<string, string> }> {
	const extension = registerHashExtension();
	const headers: Record<string, string> = {};
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(root, name), content);
		const extra = read?.[name];
		headers[name] = headerOf(await hashRead(extension, root, name, extra?.output, extra?.offset));
	}
	return { extension, headers };
}

async function holdMutationQueue(path: string): Promise<{ release: () => void; done: Promise<void> }> {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const released = new Promise<void>((resolve) => { release = resolve; });
	const done = withFileMutationQueue(path, async () => { enter(); await released; });
	await entered;
	return { release, done };
}

test("hash primitives match XXH32 vectors and ignore horizontal trailing whitespace", () => {
	assert.equal(xxHash32(""), 0x02cc5d05);
	assert.equal(xxHash32("a"), 0x550d7456);
	assert.equal(xxHash32("abc"), 0x32d153ff);
	assert.equal(hashTag("alpha  \n beta\t\n"), hashTag("alpha\n beta\n"));
});

testInDirectory("hash read result adds an OMP-style tag and absolute line numbers", async (root) => {
	writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\nfour\n");
	const result = await hashRead(
		registerHashExtension(),
		root,
		"f.txt",
		"two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]",
		2,
	);
	assert.match(result, /^\[f\.txt#[0-9A-F]{4}\]\n2:two\n3:three/m);
	assert.match(result, /Use offset=4/);
});

testInDirectory("hash applies PUT/CUT against original snapshot coordinates", async (root) => {
	const { extension, headers } = await ready(root, { "f.txt": "one\ntwo\nthree\nfour\n" });
	const result = await executeHash(extension, root, `${headers["f.txt"]}\nPUT 2.=2:\n+TWO\nPUT >3:\n+after-three\nCUT 4.=4`);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "one\nTWO\nthree\nafter-three\n");
	assert.match(result.content[0].text, /Fresh tags/);
	assert.match(result.content[0].text, /\[f\.txt#[0-9A-F]{4}\]/);
});

testInDirectory("hash supports all-or-nothing multi-file PUT and REM", async (root) => {
	const { extension, headers } = await ready(root, { "a.txt": "alpha\nbeta\n", "b.txt": "remove me\n" });
	await executeHash(extension, root, `${headers["a.txt"]}\nPUT 2.=2:\n+BETA\n${headers["b.txt"]}\nREM`);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "alpha\nBETA\n");
	assert.equal(existsSync(join(root, "b.txt")), false);
});

testInDirectory("hash rejects stale tags before mutating any file", async (root) => {
	const { extension, headers } = await ready(root, { "a.txt": "old-a\n", "b.txt": "old-b\n" });
	writeFileSync(join(root, "b.txt"), "drifted\n");
	await assert.rejects(
		executeHash(extension, root, `${headers["a.txt"]}\nPUT 1.=1:\n+new-a\n${headers["b.txt"]}\nPUT 1.=1:\n+new-b`),
		/stale tag/,
	);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "old-a\n");
	assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "drifted\n");
});

testInDirectory("hash rejects anchors that were not shown by read", async (root) => {
	const { extension, headers } = await ready(root, { "f.txt": "one\ntwo\nthree\n" }, { "f.txt": { output: "two", offset: 2 } });
	await assert.rejects(executeHash(extension, root, `${headers["f.txt"]}\nCUT 1.=1`), /was not shown by read/);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "one\ntwo\nthree\n");
});

testInDirectory("hash rejects overlapping ranges without partial mutation", async (root) => {
	const { extension, headers } = await ready(root, { "f.txt": "a\nb\nc\n" });
	await assert.rejects(executeHash(extension, root, `${headers["f.txt"]}\nPUT 1.=2:\n+x\nCUT 2.=3`), /overlapping original-line ranges/);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "a\nb\nc\n");
});

testInDirectory("hash preserves BOM and CRLF through the unified transaction writer", async (root) => {
	const { extension, headers } = await ready(
		root,
		{ "f.txt": Buffer.from("\ufeffone\r\ntwo\r\n", "utf8") },
		{ "f.txt": { output: "one\r\ntwo\r\n" } },
	);
	await executeHash(extension, root, `${headers["f.txt"]}\nPUT 2.=2:\n+TWO`);
	assert.deepEqual(readFileSync(join(root, "f.txt")), Buffer.from("\ufeffone\r\nTWO\r\n", "utf8"));
});

testInDirectory("hash MV uses the unified delete-plus-exclusive-add transaction", async (root) => {
	const { extension, headers } = await ready(root, { "old.txt": "old\n" });
	await executeHash(extension, root, `${headers["old.txt"]}\nPUT 1.=1:\n+new\nMV nested/new.txt`);
	assert.equal(existsSync(join(root, "old.txt")), false);
	assert.equal(readFileSync(join(root, "nested/new.txt"), "utf8"), "new\n");
});

testInDirectory("hash marks binary reads uneditable and refuses a forged edit", async (root) => {
	const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
	writeFileSync(join(root, "blob.bin"), bytes);
	const extension = registerHashExtension();
	assert.match(await hashRead(extension, root, "blob.bin", "��\u0000a"), /not valid UTF-8 and cannot be edited/);
	await assert.rejects(executeHash(extension, root, "[blob.bin#0000]\nCUT 1.=1"), /not valid UTF-8/);
	assert.deepEqual(readFileSync(join(root, "blob.bin")), bytes);
});

test("hash parser rejects OMP syntax-aware blocks instead of silently misapplying them", () => {
	assert.throws(() => parseHashPayload("[f.ts#ABCD]\nPUT 3*:\n+x"), /invalid PUT range/);
});

test("legacy mode settings cannot change the hash-only tool", () => {
	process.env.PI_UNIFIED_EDIT_MODE = "patch";
	try {
		const { definition } = registerHashExtension();
		assert.match(definition.description, /hash lines/i);
		assert.match(definition.promptSnippet ?? "", /hash-anchored/i);
	} finally {
		delete process.env.PI_UNIFIED_EDIT_MODE;
	}
});

test("HashSnapshotStore requires exact content even when a 16-bit tag matches normalized whitespace", () => {
	const store = new HashSnapshotStore();
	const path = "/tmp/hash-store-test";
	const tag = store.record(path, "a  \n", [1]);
	assert.ok(store.find(path, tag, "a  \n"));
	assert.equal(store.find(path, tag, "a\n"), undefined);
});

testInDirectory("removed dialect payloads fail without changes", async (root) => {
	const { extension } = await ready(root, { "f.txt": "before\n" });
	for (const payload of [
		"[f.txt]\n@APPEND\n+after",
		"*** Begin Patch\n*** Delete File: f.txt\n*** End Patch",
		'js: writeFile("f.txt", "after")',
		'```js\nwriteFile("f.txt", "after")\n```',
		'{"path":"f.txt","edits":[{"oldText":"before","newText":"after"}]}',
	]) {
		await assert.rejects(executeHash(extension, root, payload), /No changes were applied/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "before\n");
	}
});

testInDirectory("fresh tags require another read before reusing line anchors", async (root) => {
	const { extension, headers } = await ready(root, { "f.txt": "before\n" });
	const result = await executeHash(extension, root, `${headers["f.txt"]}\nPUT 1.=1:\n+after`);
	const fresh = result.content[0].text.match(/\[f\.txt#[0-9A-F]{4}\]/)![0];
	await assert.rejects(executeHash(extension, root, `${fresh}\nCUT 1.=1`), /was not shown by read/);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "after\n");
	assert.equal(headerOf(await hashRead(extension, root, "f.txt")), fresh);
	await executeHash(extension, root, `${fresh}\nCUT 1.=1`);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "");
});

testInDirectory("move collisions leave source and destination unchanged", async (root) => {
	const { extension, headers } = await ready(root, { "source.txt": "source\n", "target.txt": "target\n" });
	await assert.rejects(executeHash(extension, root, `${headers["source.txt"]}\nMV target.txt`), /already exists/);
	assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "source\n");
	assert.equal(readFileSync(join(root, "target.txt"), "utf8"), "target\n");
});

testInDirectory("argument normalization still accepts hash text through existing wrapper keys", async (root) => {
	const { definition } = registerHashExtension();
	const prepare = definition.prepareArguments as (args: unknown) => any;
	const text = "[f.txt#ABCD]\nREM";
	for (const args of [text, ...["text", "patch", "input", "content"].map((key) => ({ [key]: text }))]) {
		assert.deepEqual(prepare(args), { text });
	}
	for (const empty of ["", " "]) {
		await assert.rejects(definition.execute("empty", { text: empty }, undefined, undefined, { cwd: root } as any), /non-empty text/);
	}
});

testInDirectory("hash edits preserve missing final newline and valid NUL bytes", async (root) => {
	const { extension, headers } = await ready(root, { "f.txt": "first\nlast\0row" });
	await executeHash(extension, root, `${headers["f.txt"]}\nPUT 1.=1:\n+changed`);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "changed\nlast\0row");
});

testInDirectory("streaming stays compact, completed args preview once, and results reuse the diff", async (root) => {
	initTheme("dark", false);
	const { extension, headers } = await ready(root, { "f.txt": "before\n" });
	const args = { text: `${headers["f.txt"]}\nPUT 1.=1:\n+after` };
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
	let invalidations = 0;
	let readyPreview!: () => void;
	const previewReady = new Promise<void>((resolve) => { readyPreview = resolve; });
	const context: any = { state: {}, cwd: root, args, argsComplete: false, isError: false, invalidate: () => { invalidations++; readyPreview(); } };
	const call = extension.definition.renderCall as any;
	const component = call(args, theme, context);
	assert.match(component.render(80).join("\n"), /edit f\.txt/);
	assert.doesNotMatch(component.render(80).join("\n"), /before|after|#[0-9A-F]{4}/);
	assert.equal(invalidations, 0);
	context.argsComplete = true;
	assert.equal(call(args, theme, context), component);
	await previewReady;
	call(args, theme, context);
	assert.equal(invalidations, 1);
	assert.match(component.render(80).join("\n"), /after/);
	assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "before\n", "preview must not write");
	const result = await executeHash(extension, root, args.text);
	assert.match(result.details.patch, /^--- |^\+\+\+ /m);
	const rendered = (extension.definition.renderResult as any)(result, {}, theme, context);
	assert.deepEqual(rendered.render(80), [], "the diff already shown in the call should not be repeated");
});

testInDirectory("renderCall keeps the path visible when the terminal advertises hyperlinks", async (root) => {
	initTheme("dark", false);
	const { extension, headers } = await ready(root, { "f.txt": "before\n" });
	const args = { text: `${headers["f.txt"]}\nPUT 1.=1:\n+after` };
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
	const context: any = { state: {}, cwd: root, args, argsComplete: false, isError: false, invalidate: () => {} };
	setCapabilities(HYPERLINKS_ON);
	try {
		const linked = (extension.definition.renderCall as any)(args, theme, context).render(80).join("\n");
		assert.match(linked, /\x1b\]8;;file:\/\/[^\x1b]*f\.txt\x1b\\/, "hyperlink terminals get an OSC 8 link");
		assert.match(stripTerminalSequences(linked), /edit f\.txt/, "the linked path is still rendered as visible text");
	} finally {
		setCapabilities(HYPERLINKS_OFF);
	}
});

testInDirectory("abort before any mutation leaves files untouched", async (root) => {
	const f = join(root, "a.txt");
	writeFileSync(f, "x\n");
	await assert.rejects(
		__test.applyChanges([{ kind: "update", path: "a.txt", absolutePath: f, oldText: "x\n", newText: "y\n" }], { aborted: true } as AbortSignal),
		/Operation aborted/,
	);
	assert.equal(readFileSync(f, "utf8"), "x\n");
});

testInDirectory("queued concurrent update is preserved and the whole dry run aborts before writes", async (root) => {
	const first = join(root, "a-first.txt");
	const raced = join(root, "z-raced.txt");
	writeFileSync(first, "first-old\n");
	writeFileSync(raced, "raced-old\n");
	const held = await holdMutationQueue(raced);
	let rejected!: Promise<void>;
	try {
		rejected = assert.rejects(__test.applyChanges([
			{ kind: "update", path: "a-first.txt", absolutePath: first, oldText: "first-old\n", newText: "first-new\n" },
			{ kind: "update", path: "z-raced.txt", absolutePath: raced, oldText: "raced-old\n", newText: "ours\n" },
		]), /Preflight failed before mutating files[\s\S]*file content changed/);
		await new Promise((resolve) => setTimeout(resolve, 20));
		writeFileSync(raced, "concurrent\n");
	} finally {
		held.release();
	}
	await Promise.all([held.done, rejected]);
	assert.equal(readFileSync(first, "utf8"), "first-old\n", "no earlier target may be written");
	assert.equal(readFileSync(raced, "utf8"), "concurrent\n", "the concurrent update must not be rolled back");
});

testInDirectory("queued concurrent add collision is preserved", async (root) => {
	const target = join(root, "new.txt");
	const held = await holdMutationQueue(target);
	let rejected!: Promise<void>;
	try {
		rejected = assert.rejects(
			__test.applyChanges([{ kind: "add", path: "new.txt", absolutePath: target, oldText: "", newText: "ours\n" }]),
			/Preflight failed before mutating files[\s\S]*file already exists/,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		writeFileSync(target, "concurrent\n");
	} finally {
		held.release();
	}
	await Promise.all([held.done, rejected]);
	assert.equal(readFileSync(target, "utf8"), "concurrent\n", "the colliding file must not be deleted");
});

for (const concurrent of [false, true]) {
	testInDirectory(`rollback restores confirmed writes and preserves concurrent content (${concurrent})`, async (root) => {
		const first = join(root, "first.txt");
		const removed = join(root, "removed.txt");
		const added = join(root, "added.txt");
		const failing = join(root, "failing.txt");
		const original = Buffer.from("\ufefforiginal\r\n");
		writeFileSync(first, original);
		writeFileSync(removed, "removed\n");
		writeFileSync(failing, "before\n");
		const write = fs.writeFile;
		const mocked = mock.method(fs, "writeFile", async (...args: Parameters<typeof write>) => {
			if (args[0] === failing) {
				if (concurrent) writeFileSync(first, "concurrent\n");
				writeFileSync(failing, "external\n");
				throw new Error("injected write failure");
			}
			return write(...args);
		});
		syncBuiltinESMExports();
		try {
			await assert.rejects(__test.applyChanges([
				{ kind: "update", path: "first.txt", absolutePath: first, oldText: "original\n", newText: "ours\n" },
				{ kind: "delete", path: "removed.txt", absolutePath: removed, oldText: "removed\n", newText: "" },
				{ kind: "add", path: "added.txt", absolutePath: added, oldText: "", newText: "added\n" },
				{ kind: "update", path: "failing.txt", absolutePath: failing, oldText: "before\n", newText: "ours\n" },
			]), concurrent ? /skipped restore.*content changed/ : /Applied 3 of 4 change\(s\) before failure/);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
		}
		assert.deepEqual(readFileSync(first), concurrent ? Buffer.from("concurrent\n") : original);
		assert.equal(readFileSync(removed, "utf8"), "removed\n");
		assert.equal(existsSync(added), false);
		assert.equal(readFileSync(failing, "utf8"), "external\n", "the unconfirmed failing path must never be restored");
	});
}

testInDirectory("mutation preflight rejects invalid UTF-8 without writing earlier files", async (root) => {
	const first = join(root, "a.txt");
	const binary = join(root, "b.bin");
	const bytes = Buffer.from([0xff, 0xfe, 0x00]);
	writeFileSync(first, "before\n");
	writeFileSync(binary, bytes);
	await assert.rejects(__test.applyChanges([
		{ kind: "update", path: "a.txt", absolutePath: first, oldText: "before\n", newText: "after\n" },
		{ kind: "delete", path: "b.bin", absolutePath: binary, oldText: "", newText: "" },
	]), /not valid UTF-8/);
	assert.equal(readFileSync(first, "utf8"), "before\n");
	assert.deepEqual(readFileSync(binary), bytes);
});
