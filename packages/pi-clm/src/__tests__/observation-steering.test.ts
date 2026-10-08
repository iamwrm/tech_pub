import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { capObservations, capToolResult, observationCapFromEnv, resolveObservationCap } from "../observation.ts";
import { loadSteeringDocument, steeringPathFromEnv, steeringPromptSection, steeringStatusLine } from "../steering.ts";
import type { LiveContextMessage } from "../types.ts";

const big = (n: number) => Array.from({ length: n }, (_v, i) => `line ${i}`).join("\n");

describe("observation cap", () => {
	test("env parsing and validation", () => {
		assert.deepEqual(observationCapFromEnv({}), {});
		assert.deepEqual(observationCapFromEnv({ PI_CLM_OBSERVATION_CAP: "off" }), {});
		assert.deepEqual(observationCapFromEnv({ PI_CLM_OBSERVATION_CAP: "10000" }), { maxCharacters: 10_000 });
		assert.deepEqual(observationCapFromEnv({ PI_CLM_OBSERVATION_CAP: "10000:0.5" }), { maxCharacters: 10_000, headFraction: 0.5 });
		assert.throws(() => observationCapFromEnv({ PI_CLM_OBSERVATION_CAP: "10000:2" }), /head fraction/);
		assert.throws(() => observationCapFromEnv({ PI_CLM_OBSERVATION_CAP: "many" }), /positive number/);
		assert.throws(() => resolveObservationCap({ maxCharacters: 10 }), /at least 200/);
		assert.equal(resolveObservationCap(undefined).maxCharacters, undefined);
	});
	test("only oversized tool results change; head and tail are kept with a marker", () => {
		const policy = resolveObservationCap({ maxCharacters: 1000 });
		const text = big(400);
		const tool: LiveContextMessage = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 };
		const small: LiveContextMessage = { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 };
		const user: LiveContextMessage = { role: "user", content: big(400), timestamp: 3 };
		const capped = capToolResult(tool, policy);
		assert.notEqual(capped, tool);
		const body = (capped.content as { text: string }[])[0]!.text;
		assert.ok(body.startsWith("line 0\nline 1"));
		assert.match(body, /characters omitted/);
		assert.match(body, /line 399/);
		assert.match(body, new RegExp(`observation cap: 1,000 of ${text.length.toLocaleString("en-US")} characters shown`));
		assert.ok(body.length < 1400);
		assert.equal(capToolResult(small, policy), small);
		assert.equal(capToolResult(user, policy), user);
		assert.equal(capToolResult(tool, resolveObservationCap(undefined)), tool);
	});
	test("images survive and identity is stable across calls", () => {
		const policy = resolveObservationCap({ maxCharacters: 500 });
		const tool: LiveContextMessage = {
			role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, timestamp: 1,
			content: [{ type: "text", text: big(200) }, { type: "image", data: "abc", mimeType: "image/png" }],
		};
		const messages = [tool, { role: "user", content: "next", timestamp: 2 } as LiveContextMessage];
		const first = capObservations(messages, policy);
		const second = capObservations(messages, policy);
		assert.equal(first[0], second[0], "same capped object on repeated calls");
		assert.equal(first[1], messages[1]);
		assert.equal((first[0]!.content as unknown[]).length, 2);
		assert.equal(capObservations(messages, resolveObservationCap(undefined)), messages);
	});
});

describe("steering document", () => {
	test("env, load, hash, prompt section and status", () => {
		assert.equal(steeringPathFromEnv({}), undefined);
		assert.equal(steeringPathFromEnv({ PI_CLM_STEERING: "none" }), undefined);
		const dir = mkdtempSync(join(tmpdir(), "pi-clm-steering-"));
		const path = join(dir, "brief.md");
		writeFileSync(path, "Compact at sub-question boundaries.\n");
		assert.equal(steeringPathFromEnv({ PI_CLM_STEERING: path }), path);
		const doc = loadSteeringDocument(path);
		assert.equal(doc.name, "brief.md");
		assert.equal(doc.text, "Compact at sub-question boundaries.");
		assert.match(doc.hash, /^[a-f0-9]{12}$/);
		assert.match(steeringPromptSection(doc), /^## Context-management guidance \(brief\.md\)\n\nCompact at/);
		assert.match(steeringStatusLine(doc), /steering: brief\.md \(sha256sum [a-f0-9]{12}…\)/);
		assert.equal(steeringStatusLine(undefined), "steering: none (protocol only)");
		writeFileSync(path, "   \n");
		assert.throws(() => loadSteeringDocument(path), /empty/);
	});
	test("the shipped house-brief steering document loads", () => {
		const doc = loadSteeringDocument(new URL("../../steering/house-brief.md", import.meta.url).pathname);
		assert.match(doc.text, /When to act/);
		assert.match(doc.text, /Never fabricate/);
	});
});
