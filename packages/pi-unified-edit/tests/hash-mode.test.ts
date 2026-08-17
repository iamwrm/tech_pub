import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import unifiedEdit from "../unified-edit.ts";
import { HashSnapshotStore, hashTag, parseHashPayload, xxHash32 } from "../hash-edit.ts";

type ToolResultHandler = (event: any, ctx: any) => Promise<any> | any;

type CapturedHashExtension = {
	definition: ToolDefinition<any, any>;
	toolResult: ToolResultHandler;
};

function registerHashExtension(alias: string | undefined = "hash"): CapturedHashExtension {
	const previous = process.env.PI_UNIFIED_EDIT_MODE;
	if (alias === undefined) delete process.env.PI_UNIFIED_EDIT_MODE;
	else process.env.PI_UNIFIED_EDIT_MODE = alias;
	let definition: ToolDefinition<any, any> | undefined;
	let toolResult: ToolResultHandler | undefined;
	try {
		unifiedEdit({
			registerTool(registered: ToolDefinition<any, any>) {
				definition = registered;
			},
			on(event: string, handler: ToolResultHandler) {
				if (event === "tool_result") toolResult = handler;
			},
		} as any);
	} finally {
		if (previous === undefined) delete process.env.PI_UNIFIED_EDIT_MODE;
		else process.env.PI_UNIFIED_EDIT_MODE = previous;
	}
	assert.ok(definition, "hash mode must register edit");
	assert.ok(toolResult, "hash mode must register a read-result transformer");
	return { definition, toolResult };
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-unified-edit-hash-"));
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

function headerOf(readResult: string): string {
	const header = readResult.split("\n", 1)[0];
	assert.match(header, /^\[.+#[0-9A-F]{4}\]$/);
	return header;
}

test("hash primitives match XXH32 vectors and ignore horizontal trailing whitespace", () => {
	assert.equal(xxHash32(""), 0x02cc5d05);
	assert.equal(xxHash32("a"), 0x550d7456);
	assert.equal(xxHash32("abc"), 0x32d153ff);
	assert.equal(hashTag("alpha  \n beta\t\n"), hashTag("alpha\n beta\n"));
});

test("hash read result adds an OMP-style tag and absolute line numbers", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\nfour\n");
		const extension = registerHashExtension();
		const result = await hashRead(
			extension,
			root,
			"f.txt",
			"two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]",
			2,
		);
		assert.match(result, /^\[f\.txt#[0-9A-F]{4}\]\n2:two\n3:three/m);
		assert.match(result, /Use offset=4/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode applies PUT/CUT against original snapshot coordinates", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\nfour\n");
		const extension = registerHashExtension();
		const header = headerOf(await hashRead(extension, root, "f.txt"));
		const result = await executeHash(
			extension,
			root,
			[
				header,
				"PUT 2.=2:",
				"+TWO",
				"PUT >3:",
				"+after-three",
				"CUT 4.=4",
			].join("\n"),
		);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "one\nTWO\nthree\nafter-three\n");
		assert.match(result.content[0].text, /Fresh tags/);
		assert.match(result.content[0].text, /\[f\.txt#[0-9A-F]{4}\]/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode supports all-or-nothing multi-file PUT and REM", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "alpha\nbeta\n");
		writeFileSync(join(root, "b.txt"), "remove me\n");
		const extension = registerHashExtension();
		const a = headerOf(await hashRead(extension, root, "a.txt"));
		const b = headerOf(await hashRead(extension, root, "b.txt"));
		await executeHash(extension, root, [a, "PUT 2.=2:", "+BETA", b, "REM"].join("\n"));
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "alpha\nBETA\n");
		assert.equal(existsSync(join(root, "b.txt")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode rejects stale tags before mutating any file", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "a.txt"), "old-a\n");
		writeFileSync(join(root, "b.txt"), "old-b\n");
		const extension = registerHashExtension();
		const a = headerOf(await hashRead(extension, root, "a.txt"));
		const b = headerOf(await hashRead(extension, root, "b.txt"));
		writeFileSync(join(root, "b.txt"), "drifted\n");
		await assert.rejects(
			executeHash(extension, root, [a, "PUT 1.=1:", "+new-a", b, "PUT 1.=1:", "+new-b"].join("\n")),
			/stale tag/,
		);
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "old-a\n");
		assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "drifted\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode rejects anchors that were not shown by read", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\n");
		const extension = registerHashExtension();
		const header = headerOf(await hashRead(extension, root, "f.txt", "two", 2));
		await assert.rejects(executeHash(extension, root, [header, "CUT 1.=1"].join("\n")), /was not shown by read/);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "one\ntwo\nthree\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode rejects overlapping ranges without partial mutation", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), "a\nb\nc\n");
		const extension = registerHashExtension();
		const header = headerOf(await hashRead(extension, root, "f.txt"));
		await assert.rejects(
			executeHash(extension, root, [header, "PUT 1.=2:", "+x", "CUT 2.=3"].join("\n")),
			/overlapping original-line ranges/,
		);
		assert.equal(readFileSync(join(root, "f.txt"), "utf8"), "a\nb\nc\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode preserves BOM and CRLF through the unified transaction writer", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "f.txt"), Buffer.from("\ufeffone\r\ntwo\r\n", "utf8"));
		const extension = registerHashExtension();
		const header = headerOf(await hashRead(extension, root, "f.txt", "one\r\ntwo\r\n"));
		await executeHash(extension, root, [header, "PUT 2.=2:", "+TWO"].join("\n"));
		assert.deepEqual(readFileSync(join(root, "f.txt")), Buffer.from("\ufeffone\r\nTWO\r\n", "utf8"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode MV uses the unified delete-plus-exclusive-add transaction", async () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "old.txt"), "old\n");
		const extension = registerHashExtension();
		const header = headerOf(await hashRead(extension, root, "old.txt"));
		await executeHash(extension, root, [header, "PUT 1.=1:", "+new", "MV nested/new.txt"].join("\n"));
		assert.equal(existsSync(join(root, "old.txt")), false);
		assert.equal(readFileSync(join(root, "nested/new.txt"), "utf8"), "new\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash mode marks binary reads uneditable and refuses a forged edit", async () => {
	const root = tempDir();
	try {
		const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
		writeFileSync(join(root, "blob.bin"), bytes);
		const extension = registerHashExtension();
		const readResult = await hashRead(extension, root, "blob.bin", "��\u0000a");
		assert.match(readResult, /not valid UTF-8 and cannot be edited/);
		await assert.rejects(executeHash(extension, root, "[blob.bin#0000]\nCUT 1.=1"), /not valid UTF-8/);
		assert.deepEqual(readFileSync(join(root, "blob.bin")), bytes);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hash parser rejects OMP syntax-aware blocks instead of silently misapplying them", () => {
	assert.throws(() => parseHashPayload("[f.ts#ABCD]\nPUT 3*:\n+x"), /invalid PUT range/);
});

test("PI_UNIFIED_EDIT_MODE=hashline is accepted as a hash alias", () => {
	const extension = registerHashExtension("hashline");
	assert.match(extension.definition.description, /hash lines/i);
	assert.match(extension.definition.promptSnippet ?? "", /hash-anchored/i);
});

test("unset and unknown PI_UNIFIED_EDIT_MODE default to hash", () => {
	for (const alias of [undefined, "", "not-a-mode"] as const) {
		const extension = registerHashExtension(alias);
		assert.match(extension.definition.description, /hash lines/i);
		assert.match(extension.definition.promptSnippet ?? "", /hash-anchored/i);
		assert.ok(extension.toolResult, "default hash mode must transform read results");
	}
});

test("HashSnapshotStore requires exact content even when a 16-bit tag matches normalized whitespace", () => {
	const store = new HashSnapshotStore();
	const path = "/tmp/hash-store-test";
	const tag = store.record(path, "a  \n", [1]);
	assert.ok(store.find(path, tag, "a  \n"));
	assert.equal(store.find(path, tag, "a\n"), undefined);
});
