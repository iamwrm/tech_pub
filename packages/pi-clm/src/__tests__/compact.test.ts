import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildCompactPrompt, compactPromptFromEnv, DEFAULT_COMPACT_PROMPT, loadCompactPrompt } from "../compact.ts";
import { settingDescriptor } from "../settings.ts";

describe("/clm-compact", () => {
	test("the prompt fills placeholders, leaves unknown ones, and drops the empty instructions line", () => {
		const values = { mirror: "/tmp/LIVE_CONTEXT.md", current: 110_000, budget: 1_000_000 };
		const prompt = buildCompactPrompt(DEFAULT_COMPACT_PROMPT, values);
		assert.match(prompt, /^Compact your live context now\./);
		assert.match(prompt, /about 110k tokens \(budget 1m\)\. Your context is mirrored at `\/tmp\/LIVE_CONTEXT\.md`/);
		assert.doesNotMatch(prompt, /\{\{|Also:|\n{3}/);
		assert.match(buildCompactPrompt(DEFAULT_COMPACT_PROMPT, { ...values, instructions: " keep ids " }), /\n\nAlso: keep ids\n\n/);
		assert.equal(buildCompactPrompt("{{current}}{{budget}} {{other}}", { ...values, budget: undefined }), "110k {{other}}");
		assert.equal(buildCompactPrompt("{{constructor}} {{__proto__}} {{toString}}", values), "{{constructor}} {{__proto__}} {{toString}}", "only its own placeholders are filled");
		assert.equal(buildCompactPrompt("Shrink {{mirror}}.", { ...values, instructions: "keep ids" }), "Shrink /tmp/LIVE_CONTEXT.md.\n\nAlso: keep ids", "typed instructions are never dropped");
		assert.equal(buildCompactPrompt("A\n\n\n\nB\n\n{{instructions}}\n\nC", values), "A\n\n\n\nB\n\nC", "only the empty slot's blank lines collapse");
		assert.equal(buildCompactPrompt("A {{instructions}}B", values), "A B");
	});

	test("the compact prompt setting takes a typed path (a cycle would lose it) and env keywords mean built in", () => {
		const descriptor = settingDescriptor("compact-prompt")!;
		assert.equal(descriptor.choices, undefined);
		assert.ok(descriptor.placeholder);
		assert.deepEqual(descriptor.parse("default", ""), { compactPrompt: null });
		assert.equal(compactPromptFromEnv({ PI_CLM_COMPACT_PROMPT: " Default " }), undefined);
		assert.equal(compactPromptFromEnv({ PI_CLM_COMPACT_PROMPT: "off" }), undefined);
		assert.equal(compactPromptFromEnv({ PI_CLM_COMPACT_PROMPT: "prompts/team.md" }), "prompts/team.md");
	});

	test("a custom template is read on use; missing or empty files are errors", async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "clm-compact-test-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const path = join(directory, "prompt.md");
		assert.equal(loadCompactPrompt(undefined), DEFAULT_COMPACT_PROMPT);
		await writeFile(path, "  Compact {{mirror}}.  \n");
		assert.equal(loadCompactPrompt(path), "Compact {{mirror}}.");
		await writeFile(path, "\n");
		assert.throws(() => loadCompactPrompt(path), /compact prompt is empty/);
		assert.throws(() => loadCompactPrompt(join(directory, "missing.md")), /compact prompt not loaded: ENOENT/);
	});
});
