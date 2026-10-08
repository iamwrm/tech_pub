import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	CONTINUITY_SIZE_WARNING_TOKENS,
	LIVE_CONTEXT_ANNOTATION,
	activeContinuityAnnotations,
	ContinuitySizeTracker,
	findSourceEntry,
	formatContinuityMessage,
	formatRecall,
	reconstructLiveContextAnnotations,
	resolveAnnotation,
	sourceContentHash,
	validateAnnotationSource,
	type LiveContextAnnotation,
} from "../continuity.ts";
import type { LiveContextMessage } from "../types.ts";

const source: LiveContextMessage = {
	role: "user",
	content: "Keep the live-context-agent request available for the next task.",
	timestamp: 3,
};
const sourceEntry = {
	type: "message",
	id: "source-1",
	parentId: "parent",
	timestamp: "2026-08-30T00:00:00.000Z",
	message: source,
};

function annotation(
	retention: LiveContextAnnotation["retention"] = "continuity",
): LiveContextAnnotation {
	return {
		version: 1,
		id: retention === "pin" ? "lc-111111111111" : retention === "archive" ? "lc-222222222222" : "lc-000000000000",
		source: {
			sessionId: "session-1",
			entryId: "source-1",
			revision: 4,
			contentHash: sourceContentHash(source),
			role: "user",
		},
		title: "Live-context-agent follow-up",
		reason: "The user selected it as the next task.",
		futureAction: "Recall before implementing agent spawning.",
		retention,
		createdAt: "2026-08-30T00:01:00.000Z",
	};
}

describe("durable continuity annotations", () => {
	test("the latest valid snapshot for each id wins on the supplied branch", () => {
		const created = annotation();
		const resolved = resolveAnnotation(created, "Implemented", "2026-08-30T00:02:00.000Z");
		const entries = [
			{ type: "custom", customType: LIVE_CONTEXT_ANNOTATION, data: created },
			{ type: "custom", customType: LIVE_CONTEXT_ANNOTATION, data: { invalid: true } },
			{ type: "custom", customType: LIVE_CONTEXT_ANNOTATION, data: resolved },
		];
		assert.deepEqual(reconstructLiveContextAnnotations(entries), [resolved]);
		assert.deepEqual(activeContinuityAnnotations([resolved]), []);
		assert.deepEqual(reconstructLiveContextAnnotations(entries.slice(0, 1)), [created]);
		assert.deepEqual(reconstructLiveContextAnnotations([{ type: "message", id: "earlier-branch" }]), []);
	});

	test("source lookup and content hashes bind an annotation to the durable entry", () => {
		assert.equal(findSourceEntry([sourceEntry], source), sourceEntry);
		assert.equal(validateAnnotationSource(annotation(), sourceEntry), source);
		assert.throws(
			() => validateAnnotationSource(annotation(), { ...sourceEntry, message: { ...source, content: "changed" } }),
			/content-hash check/,
		);
	});

	test("continuity is a pointer, archive is hidden, and pin restores exact text only when absent", () => {
		const continuity = formatContinuityMessage({
			annotations: [annotation()],
			entries: [sourceEntry],
			effectiveMessages: [],
		});
		assert.match(continuity ?? "", /lc-000000000000/);
		assert.doesNotMatch(continuity ?? "", /Keep the live-context-agent request available/);

		const archived = formatContinuityMessage({
			annotations: [annotation("archive")],
			entries: [sourceEntry],
			effectiveMessages: [],
		});
		assert.equal(archived, undefined);

		const pinned = formatContinuityMessage({
			annotations: [annotation("pin")],
			entries: [sourceEntry],
			effectiveMessages: [],
		});
		assert.match(pinned ?? "", /Keep the live-context-agent request available/);
		const alreadyVisible = formatContinuityMessage({
			annotations: [annotation("pin")],
			entries: [sourceEntry],
			effectiveMessages: [source],
		});
		assert.doesNotMatch(alreadyVisible ?? "", /<live-context-pinned-source>/);
		assert.match(alreadyVisible ?? "", /already present/);
	});

	test("aggregate continuity size warns once per threshold crossing and re-arms after shrinking", () => {
		const tracker = new ContinuitySizeTracker();
		assert.equal(tracker.observe(CONTINUITY_SIZE_WARNING_TOKENS - 1), false);
		assert.equal(tracker.observe(CONTINUITY_SIZE_WARNING_TOKENS), true);
		assert.equal(tracker.observe(CONTINUITY_SIZE_WARNING_TOKENS * 2), false);
		assert.equal(tracker.observe(CONTINUITY_SIZE_WARNING_TOKENS - 1), false);
		assert.equal(tracker.observe(CONTINUITY_SIZE_WARNING_TOKENS + 1), true);
		tracker.reset();
		assert.equal(tracker.observe(CONTINUITY_SIZE_WARNING_TOKENS), true);
	});

	test("recall is bounded and reports truncation without creating another store", () => {
		const longSource = { ...source, content: "important source line\n".repeat(2_000) };
		const archived = {
			...annotation("archive"),
			source: { ...annotation("archive").source, contentHash: sourceContentHash(longSource) },
		};
		const estimate = (text: string) => Math.ceil(text.length / 4);
		const recalled = formatRecall({
			annotation: archived,
			source: longSource,
			maxTokens: 128,
			estimateTokens: estimate,
		});
		assert.equal(recalled.truncated, true);
		assert.ok(recalled.totalTokens > 128);
		assert.ok(recalled.returnedTokens <= 128);
		assert.match(recalled.text, /source truncated/);
	});
});
