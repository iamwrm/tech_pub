import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import { createProjectionCheckpoint } from "../projection.ts";
import { LIVE_CONTEXT_STATE, initialLiveContextState, type LiveContextState } from "../state.ts";
import {
	buildLiveContextViewModel,
	CLM_VIEW_TABS,
	formatLiveContextReport,
	LiveContextViewer,
	type LiveContextViewModel,
	windowAroundSelection,
} from "../viewer.ts";
import type { LiveContextMessage } from "../types.ts";

const raw: LiveContextMessage[] = [
	{ role: "user", content: "Build a viewer", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "Very long investigation ".repeat(100) }], timestamp: 2 },
	{ role: "user", content: "Keep the agent analysis", timestamp: 3 },
];
const projected: LiveContextMessage[] = [
	raw[0],
	{ role: "assistant", content: [{ type: "text", text: "Viewer implementation summary" }], timestamp: 2 },
	raw[2],
];

function projectedState(): LiveContextState {
	const checkpoint = createProjectionCheckpoint({
		revision: 2,
		sourceMessages: raw,
		projectedMessages: projected,
		beforeEstimate: 2_500,
		afterEstimate: 100,
		estimateUnit: "tokens",
		createdAt: "2026-08-29T10:00:00.000Z",
	});
	return {
		version: 1,
		enabled: true,
		revision: 2,
		checkpoint,
		lastOutcome: {
			kind: "applied",
			message: "Applied revision 2.",
			beforeEstimate: 2_500,
			afterEstimate: 100,
			estimateUnit: "tokens",
			at: "2026-08-29T10:00:00.000Z",
		},
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as any;

describe("live-context viewer model", () => {
	test("reports the current raw-to-effective projection and persisted history", () => {
		const initial = initialLiveContextState();
		const state = projectedState();
		const model = buildLiveContextViewModel({
			state,
			entries: [
				{ type: "custom", customType: LIVE_CONTEXT_STATE, data: initial },
				{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state },
			],
			current: {
				rawMessageCount: 4,
				rawMessages: [...raw, { role: "assistant", content: "new suffix", timestamp: 4 }],
				effectiveMessages: [...projected, { role: "assistant", content: "new suffix", timestamp: 4 }],
				suffixMessageCount: 1,
				rawTokens: 2_600,
				effectiveTokens: 110,
				capturedAt: "2026-08-29T10:01:00.000Z",
			},
			mirrorPath: "/tmp/LIVE_CONTEXT.md",
			sessionId: "parent-session",
			sessionFile: "/tmp/session.jsonl",
			mode: "tui",
			env: { PI_TEAM_MATE_COORDINATOR: "1" },
		});

		assert.equal(model.beforeEstimate, 2_600);
		assert.equal(model.afterEstimate, 110);
		assert.equal(model.savingsEstimate, 2_490);
		assert.equal(model.estimateUnit, "tokens");
		assert.equal(model.rawMessageCount, 4);
		assert.equal(model.effectiveMessageCount, 4);
		assert.equal(model.suffixMessageCount, 1);
		assert.equal(model.runtime.kind, "coordinator");
		assert.equal(model.history.length, 2);
		assert.equal(model.history.at(-1)?.event, "applied");
		assert.equal(model.editTraceSource, "reconstructed");
		assert.equal(model.edits.find((edit) => edit.sourceIndex === 2)?.kind, "edited");
		assert.equal(model.messages[0].protected, true);
		assert.equal(model.messages[2].protected, true);
		assert.match(formatLiveContextReport(model), /tokens: 2600 -> 110/);
		assert.match(formatLiveContextReport(model), /coordinator/);
	});

	test("recorded edit provenance uses the reset source revision rather than an older checkpoint", () => {
		const oldCheckpoint = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: raw,
			projectedMessages: projected,
			beforeEstimate: 600,
			afterEstimate: 20,
			estimateUnit: "tokens",
		});
		const reset: LiveContextState = {
			version: 1,
			enabled: true,
			revision: 2,
			lastOutcome: { kind: "reset", message: "reset", at: "2026-08-29T10:02:00.000Z" },
		};
		const nextProjected: LiveContextMessage[] = [
			raw[0],
			{ ...raw[1], content: [{ type: "text", text: "Fresh summary after reset" }] },
			raw[2],
		];
		const checkpoint = createProjectionCheckpoint({
			revision: 3,
			sourceMessages: raw,
			projectedMessages: nextProjected,
			beforeEstimate: 600,
			afterEstimate: 20,
			estimateUnit: "tokens",
			editTrace: {
				version: 1,
				sourceRevision: 2,
				sourceMessageCount: 3,
				outputMessageCount: 3,
				sources: [
					{ sourceIndex: 0, outputIndex: 0, kind: "kept" },
					{ sourceIndex: 1, outputIndex: 1, kind: "edited" },
					{ sourceIndex: 2, outputIndex: 2, kind: "kept" },
				],
				additions: [],
			},
		});
		const oldState: LiveContextState = { version: 1, enabled: true, revision: 1, checkpoint: oldCheckpoint };
		const current: LiveContextState = { version: 1, enabled: true, revision: 3, checkpoint };
		const model = buildLiveContextViewModel({
			state: current,
			entries: [oldState, reset, current].map((data) => ({ type: "custom", customType: LIVE_CONTEXT_STATE, data })),
			rawMessages: raw,
			sessionId: "session",
			mode: "tui",
		});

		assert.equal(model.editTraceSource, "recorded");
		assert.match(model.edits[1]?.beforePreview ?? "", /Very long investigation/);
		assert.match(model.edits[1]?.afterPreview ?? "", /Fresh summary after reset/);
	});

	test("shows every compression run and recomputes legacy history in tokens", () => {
		const firstCheckpoint = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: raw,
			projectedMessages: projected,
			beforeEstimate: 10_000,
			afterEstimate: 500,
			createdAt: "2026-08-29T09:00:00.000Z",
		});
		const first: LiveContextState = {
			version: 1,
			enabled: true,
			revision: 1,
			checkpoint: firstCheckpoint,
			lastOutcome: {
				kind: "applied",
				message: "Applied legacy revision 1.",
				beforeEstimate: 10_000,
				afterEstimate: 500,
				at: "2026-08-29T09:00:00.000Z",
			},
		};
		const slimOutcome: LiveContextState = {
			version: 1,
			enabled: true,
			revision: 1,
			lastOutcome: {
				kind: "rejected",
				message: "A later mirror edit was rejected.",
				at: "2026-08-29T09:30:00.000Z",
			},
		};
		const secondProjected: LiveContextMessage[] = [
			projected[0],
			{ ...projected[1], content: [{ type: "text", text: "Short final viewer summary" }] },
			projected[2],
		];
		const secondCheckpoint = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: raw,
			projectedMessages: secondProjected,
			beforeEstimate: 18,
			afterEstimate: 15,
			estimateUnit: "tokens",
			createdAt: "2026-08-29T10:00:00.000Z",
			editTrace: {
				version: 1,
				sourceRevision: 1,
				sourceMessageCount: 3,
				outputMessageCount: 3,
				sources: [
					{ sourceIndex: 0, outputIndex: 0, kind: "kept" },
					{ sourceIndex: 1, outputIndex: 1, kind: "edited" },
					{ sourceIndex: 2, outputIndex: 2, kind: "kept" },
				],
				additions: [],
			},
		});
		const second: LiveContextState = {
			version: 1,
			enabled: true,
			revision: 2,
			checkpoint: secondCheckpoint,
			lastOutcome: {
				kind: "applied",
				message: "Applied revision 2.",
				beforeEstimate: 18,
				afterEstimate: 15,
				estimateUnit: "tokens",
				at: "2026-08-29T10:00:00.000Z",
			},
		};
		const model = buildLiveContextViewModel({
			state: second,
			entries: [initialLiveContextState(), first, slimOutcome, second].map((data) => ({
				type: "custom",
				customType: LIVE_CONTEXT_STATE,
				data,
			})),
			rawMessages: raw,
			sessionId: "session",
			mode: "tui",
		});

		assert.deepEqual(model.editRevisions.map((revision) => revision.revision), [1, 2]);
		assert.equal(model.editRevisions[0]?.traceSource, "reconstructed");
		assert.equal(model.editRevisions[1]?.traceSource, "recorded");
		assert.match(model.editRevisions[1]?.edits[1]?.beforePreview ?? "", /Viewer implementation summary/);
		const legacy = model.history.find((event) => event.revision === 1 && event.event === "applied");
		assert.equal(legacy?.estimateUnit, "tokens");
		assert.equal(legacy?.estimateSource, "recomputed");
		assert.notEqual(legacy?.beforeEstimate, 10_000);

		const viewer = new LiveContextViewer(
			{ terminal: { rows: 30 }, requestRender() {} } as any,
			theme,
			model,
			"edit",
			() => {},
		);
		assert.match(viewer.render(80).join("\n"), /r1\s+\[r2\]/);
		viewer.handleInput("\x1b[D");
		const earlierRevision = viewer.render(80).join("\n");
		assert.match(earlierRevision, /\[2:edit\]/);
		assert.match(earlierRevision, /←\s+\[r1\]\s+r2\s+→/);
		assert.match(earlierRevision, /reconstructed legacy provenance/);
		assert.doesNotMatch(earlierRevision, /\[\/\] revision/);
		viewer.handleInput("\x1b[C");
		assert.match(viewer.render(80).join("\n"), /r1\s+\[r2\]/);
		viewer.handleInput("[");
		assert.match(viewer.render(80).join("\n"), /\[r1\]\s+r2/);
	});

	test("uses explicit toggle events even when adjacent enabled flags are unchanged", () => {
		const initial = initialLiveContextState();
		const enabledAgain: LiveContextState = {
			version: 1,
			enabled: true,
			revision: 0,
			event: { kind: "enabled", at: "2026-08-29T11:00:00.000Z" },
		};
		const model = buildLiveContextViewModel({
			state: enabledAgain,
			entries: [initial, enabledAgain].map((data) => ({
				type: "custom",
				customType: LIVE_CONTEXT_STATE,
				data,
			})),
			sessionId: "session",
			mode: "tui",
		});
		assert.equal(model.history.at(-1)?.event, "enabled");
		assert.equal(model.history.at(-1)?.at, "2026-08-29T11:00:00.000Z");
	});

	test("rebuilds provenance from the same context-visible message space", () => {
		const rawWithExcluded: LiveContextMessage[] = [
			{ role: "user", content: "Build a viewer", timestamp: 1 },
			{
				role: "bashExecution",
				command: "cat private-notes",
				output: "excluded private output",
				excludeFromContext: true,
				timestamp: 2,
			},
			{ role: "assistant", content: [{ type: "text", text: "Long investigation" }], timestamp: 3 },
			{ role: "user", content: "Continue", timestamp: 4 },
		];
		const projectedVisible: LiveContextMessage[] = [
			rawWithExcluded[0],
			{ role: "assistant", content: [{ type: "text", text: "Short summary" }], timestamp: 3 },
			rawWithExcluded[3],
		];
		const checkpoint = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: rawWithExcluded,
			projectedMessages: projectedVisible,
			beforeEstimate: 12,
			afterEstimate: 8,
			estimateUnit: "tokens",
			editTrace: {
				version: 1,
				sourceRevision: 0,
				sourceMessageCount: 3,
				outputMessageCount: 3,
				sources: [
					{ sourceIndex: 0, outputIndex: 0, kind: "kept" },
					{ sourceIndex: 1, outputIndex: 1, kind: "edited" },
					{ sourceIndex: 2, outputIndex: 2, kind: "kept" },
				],
				additions: [],
			},
		});
		const state: LiveContextState = { version: 1, enabled: true, revision: 1, checkpoint };
		const model = buildLiveContextViewModel({
			state,
			entries: [{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state }],
			rawMessages: rawWithExcluded,
			sessionId: "session",
			mode: "tui",
		});
		assert.equal(model.editTraceSource, "recorded");
		assert.equal(model.edits.length, 3);
		assert.match(model.edits[1]?.beforePreview ?? "", /Long investigation/);
		assert.doesNotMatch(JSON.stringify(model.edits), /excluded private output/);
	});

	test("renders correct guides for multiple root conversations", () => {
		const rootA = { role: "user", content: "Root A", timestamp: 1 } as LiveContextMessage;
		const childA = { role: "user", content: "Child A", timestamp: 2 } as LiveContextMessage;
		const rootB = { role: "user", content: "Root B", timestamp: 3 } as LiveContextMessage;
		const model = buildLiveContextViewModel({
			state: initialLiveContextState(),
			entries: [],
			tree: [
				{
					entry: { type: "message", id: "root-a", parentId: null, timestamp: "2026-08-29T00:00:00.000Z", message: rootA },
					children: [{
						entry: { type: "message", id: "child-a", parentId: "root-a", timestamp: "2026-08-29T00:00:01.000Z", message: childA },
						children: [],
					}],
				},
				{
					entry: { type: "message", id: "root-b", parentId: null, timestamp: "2026-08-29T00:00:02.000Z", message: rootB },
					children: [],
				},
			] as any,
			leafId: "child-a",
			sessionId: "session",
			mode: "tui",
		});
		assert.deepEqual(model.tree.map((row) => row.prefix), ["├─ ", "│  ", "└─ "]);
	});

	test("keeps a linear conversation chain at one indentation level", () => {
		const turns = Array.from({ length: 5 }, (_value, index) => ({
			role: "user",
			content: `Turn ${index + 1}`,
			timestamp: index + 1,
		})) as LiveContextMessage[];
		let children: any[] = [];
		for (let index = turns.length - 1; index >= 0; index--) {
			children = [{
				entry: {
					type: "message",
					id: `t${index + 1}`,
					parentId: index === 0 ? null : `t${index}`,
					timestamp: `2026-08-29T00:00:0${index}.000Z`,
					message: turns[index],
				},
				children,
			}];
		}
		const model = buildLiveContextViewModel({
			state: initialLiveContextState(),
			entries: [],
			tree: children as any,
			leafId: "t5",
			sessionId: "session",
			mode: "tui",
		});
		assert.equal(model.tree.length, 5);
		assert.deepEqual(model.tree.map((row) => row.prefix), ["", "", "", "", ""]);
	});

	test("marks snapshots that predate newer raw session activity", () => {
		const state = projectedState();
		const model = buildLiveContextViewModel({
			state,
			entries: [{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state }],
			snapshotStale: true,
			rawMessages: raw,
			sessionId: "session",
			mode: "tui",
		});
		assert.equal(model.snapshotStale, true);
		assert.match(formatLiveContextReport(model), /newer raw messages were recorded after this snapshot/);
		const tui = { terminal: { rows: 30 }, requestRender: () => {} } as any;
		const viewer = new LiveContextViewer(tui, theme, model, "overview", () => {});
		assert.match(viewer.render(90).join("\n"), /Newer raw messages were recorded after this snapshot/);
	});

	test("materializes per-tab data lazily and memoizes it", () => {
		const state = projectedState();
		const model = buildLiveContextViewModel({
			state,
			entries: [{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state }],
			rawMessages: raw,
			sessionId: "session",
			mode: "tui",
		});
		for (const property of ["messages", "edits", "editRevisions", "tree", "history"] as const) {
			assert.ok(Object.getOwnPropertyDescriptor(model, property)?.get, `${property} is deferred`);
		}
		assert.equal(model.tree, model.tree);
		assert.equal(model.editRevisions, model.editRevisions);
		assert.equal(model.history, model.history);
		assert.equal(model.messages, model.messages);
	});

	test("counts a tool result rewritten into a context note as rewritten", () => {
		const user = { role: "user", content: "Task", timestamp: 1 } as LiveContextMessage;
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "Investigating" }],
			timestamp: 2,
		} as LiveContextMessage;
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			content: [{ type: "text", text: "very large output" }],
			timestamp: 3,
		} as LiveContextMessage;
		const note = {
			role: "custom",
			customType: "live-context-projection",
			content: "[summary of the tool output]",
			display: false,
			timestamp: 3,
		} as LiveContextMessage;
		const model = buildLiveContextViewModel({
			state: initialLiveContextState(),
			entries: [],
			tree: [
				{
					entry: { type: "message", id: "root", parentId: null, timestamp: "2026-08-29T00:00:00.000Z", message: user },
					children: [{
						entry: { type: "message", id: "a", parentId: "root", timestamp: "2026-08-29T00:00:01.000Z", message: assistant },
						children: [{
							entry: { type: "message", id: "t", parentId: "a", timestamp: "2026-08-29T00:00:02.000Z", message: toolResult },
							children: [],
						}],
					}],
				},
			] as any,
			leafId: "t",
			current: {
				rawMessageCount: 3,
				rawMessages: [user, assistant, toolResult],
				effectiveMessages: [user, assistant, note],
				suffixMessageCount: 0,
				rawTokens: 40,
				effectiveTokens: 20,
				capturedAt: "2026-08-29T00:00:03.000Z",
			},
			sessionId: "session",
			mode: "tui",
		});
		const turn = model.tree[0];
		assert.equal(turn?.status, "1 rewritten");
		assert.match(turn?.details.join("\n") ?? "", /2 unchanged · 1 rewritten · 0 omitted/);
	});

	test("does not treat an unrelated custom notice as rewrite provenance", () => {
		const user = { role: "user", content: "Task", timestamp: 1 } as LiveContextMessage;
		const assistant = { role: "assistant", content: "Investigating", timestamp: 2 } as LiveContextMessage;
		const toolResult = {
			role: "toolResult",
			toolCallId: "call-1",
			content: "large output",
			timestamp: 3,
		} as LiveContextMessage;
		const notice = {
			role: "custom",
			customType: "live-context-notice",
			content: "Context pressure crossed 50%.",
			display: false,
			timestamp: 3,
		} as LiveContextMessage;
		const model = buildLiveContextViewModel({
			state: initialLiveContextState(),
			entries: [],
			tree: [{
				entry: { type: "message", id: "root", parentId: null, timestamp: "2026-08-29T00:00:00.000Z", message: user },
				children: [{
					entry: { type: "message", id: "a", parentId: "root", timestamp: "2026-08-29T00:00:01.000Z", message: assistant },
					children: [{
						entry: { type: "message", id: "t", parentId: "a", timestamp: "2026-08-29T00:00:02.000Z", message: toolResult },
						children: [],
					}],
				}],
			}] as any,
			leafId: "t",
			current: {
				rawMessageCount: 3,
				rawMessages: [user, assistant, toolResult],
				effectiveMessages: [user, assistant, notice],
				suffixMessageCount: 0,
				rawTokens: 40,
				effectiveTokens: 20,
				capturedAt: "2026-08-29T00:00:03.000Z",
			},
			sessionId: "session",
			mode: "tui",
		});
		const turn = model.tree[0];
		assert.equal(turn?.status, "2/3 effective");
		assert.match(turn?.details.join("\n") ?? "", /2 unchanged · 0 rewritten · 1 omitted/);
	});

	test("detects durable team-mode teammates without coupling projection state", () => {
		const model = buildLiveContextViewModel({
			state: initialLiveContextState(),
			entries: [],
			sessionId: "child-session",
			mode: "json",
			env: {
				PI_TEAM_MATE_SUBPROCESS: "1",
				PI_TEAM_MATE_TEAMMATE_NAME: "reviewer",
				PI_TEAM_MATE_PARENT_SESSION_ID: "parent-session",
			},
		});
		assert.equal(model.runtime.kind, "teammate");
		assert.equal(model.runtime.teammateName, "reviewer");
		assert.equal(model.runtime.parentSessionId, "parent-session");
	});
});

describe("live-context viewer TUI", () => {
	test("renders bounded lines and navigates between tabs", () => {
		let renderRequests = 0;
		let closed = false;
		const tui = {
			terminal: { rows: 30 },
			requestRender: () => {
				renderRequests++;
			},
		} as any;
		const state = projectedState();
		const model = buildLiveContextViewModel({
			state,
			entries: [{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state }],
			rawMessages: raw,
			tree: [
				{
					entry: { type: "message", id: "root", parentId: null, timestamp: "2026-08-29T10:00:00.000Z", message: raw[0] },
					children: [
						{
							entry: { type: "message", id: "assistant", parentId: "root", timestamp: "2026-08-29T10:00:30.000Z", message: raw[1] },
							children: [
								{
									entry: { type: "custom", id: "state", parentId: "assistant", timestamp: "2026-08-29T10:01:00.000Z", customType: LIVE_CONTEXT_STATE, data: state },
									children: [],
								},
							],
						},
					],
				},
			] as any,
			leafId: "state",
			sessionId: "session",
			mode: "tui",
			env: {},
		});
		const viewer = new LiveContextViewer(tui, theme, model, "overview", () => {
			closed = true;
		});

		const overview = viewer.render(72);
		assert.ok(overview.every((line) => visibleWidth(line) <= 72));
		assert.match(overview.join("\n"), /Projection projected/);

		viewer.handleInput("\x1b[C");
		const unchangedTab = viewer.render(72).join("\n");
		assert.match(unchangedTab, /\[1:overview\]/);
		assert.doesNotMatch(unchangedTab, /Live-context compression runs/);
		viewer.handleInput("\t");
		const collapsedEdit = viewer.render(72).join("\n");
		assert.match(collapsedEdit, /Live-context compression runs/);
		assert.doesNotMatch(collapsedEdit, /Very long investigation/);
		viewer.handleInput("j");
		viewer.handleInput("\r");
		const expandedEdit = viewer.render(72).join("\n");
		assert.match(expandedEdit, /Very long investigation/);

		viewer.handleInput("3");
		const projection = viewer.render(72).join("\n");
		assert.match(projection, /Current effective messages/);

		viewer.handleInput("4");
		const tree = viewer.render(72).join("\n");
		assert.match(tree, /Conversation tree/);
		assert.match(tree, /T1 · user/);
		assert.match(tree, /Live context r2/);
		assert.match(tree, /1 assistant\/tool\/bookkeeping/);
		assert.doesNotMatch(tree, /assistant: Very long investigation/);

		viewer.handleInput("\r");
		assert.match(viewer.render(72).join("\n"), /Checkpoint replaces/);
		viewer.handleInput("k");
		viewer.handleInput(" ");
		const expandedTurn = viewer.render(72).join("\n");
		assert.match(expandedTurn, /Raw user message:/);
		assert.match(expandedTurn, /assistant:/);
		assert.match(expandedTurn, /Very long investigation/);
		assert.ok(renderRequests > 0);

		viewer.handleInput("q");
		assert.equal(closed, true);
	});

	test("shows one restored original and keeps the overlay compact", () => {
		const state = projectedState();
		const base = buildLiveContextViewModel({
			state,
			entries: [],
			rawMessages: raw,
			sessionId: "session",
			mode: "tui",
		});
		const restoredRevision = {
			revision: 2,
			sourceRevision: 1,
			beforeTokens: 10,
			afterTokens: 10,
			traceSource: "recorded" as const,
			edits: [{
				kind: "restored" as const,
				sourceIndex: 1,
				outputIndex: 1,
				beforeRole: "user",
				afterRole: "user",
				beforeTokens: 10,
				afterTokens: 10,
				beforeDetail: "RESTORED ORIGINAL CONTENT",
				afterDetail: "RESTORED ORIGINAL CONTENT",
			}],
		};
		const viewer = new LiveContextViewer(
			{ terminal: { rows: 100 }, requestRender() {} } as any,
			theme,
			{ ...base, editRevisions: [restoredRevision], edits: restoredRevision.edits },
			"edit",
			() => {},
		);
		viewer.handleInput("\r");
		const rendered = viewer.render(80);
		assert.ok(rendered.length <= 32, "the overlay should remain bounded during background redraws");
		assert.equal(rendered.join("\n").match(/RESTORED ORIGINAL CONTENT/g)?.length, 1);
		assert.match(rendered.join("\n"), /restored original/);
	});

	test("the overview opens fitted on the latest request; z zooms to requests (panning, centred) and turns", () => {
		const points = Array.from({ length: 300 }, (_v, i) => ({
			request: i + 1,
			at: new Date(Date.UTC(2026, 0, 1, 9, 0) + i * 60_000).toISOString(),
			tokens: 1_000 + (i % 50) * 100,
			revision: i < 150 ? 0 : 1,
		}));
		const markers = [
			{ kind: "applied" as const, revision: 1, afterPoint: 19, beforeTokens: 5_000, afterTokens: 1_000, message: "applied r1" },
			{ kind: "applied" as const, revision: 2, afterPoint: 149, beforeTokens: 5_000, afterTokens: 1_000, message: "applied r2" },
		];
		const model: LiveContextViewModel = {
			enabled: true,
			revision: 2,
			beforeEstimate: 100,
			afterEstimate: 50,
			savingsEstimate: 50,
			estimateUnit: "tokens",
			savingsPercent: 50,
			rawMessageCount: 1,
			effectiveMessageCount: 1,
			suffixMessageCount: 0,
			snapshotStale: false,
			messages: [],
			timeline: { points, markers, peakTokens: 5_900, turnStarts: [0, 100, 200] },
			edits: [],
			editTraceSource: "recorded",
			editRevisions: [],
			tree: [],
			treeHiddenEntryCount: 0,
			history: [],
			runtime: { kind: "standalone", sessionId: "session", mode: "tui" },
		};
		const viewer = new LiveContextViewer({ terminal: { rows: 40 }, requestRender() {} } as any, theme, model, "overview", () => {}, CLM_VIEW_TABS);
		const xLabel = (text: string) => text.match(/(?:◂ \d+ earlier {2})?requests \d+–\d+ of 300(?: {2}\d+ later ▸)?/)?.[0] ?? "";
		const window = (text: string) => xLabel(text).match(/requests (\d+)–(\d+)/)!.slice(1).map(Number) as [number, number];

		// Opens fitted: the whole branch, now selected and expanded.
		const opened = viewer.render(80).join("\n");
		assert.match(opened, /Context size · 300 requests · now 5\.9k · peak 5\.9k/);
		assert.match(opened, /all 300 requests · 5\/column/);
		assert.match(opened, /z zoom: all/);
		assert.match(opened, /› ▾ now .*\n *│? *\d{2}:\d{2}.*–.*\(\d+ min\).*\n.*Enter: current input/, "the selected row expands with its time period");
		assert.doesNotMatch(opened, /peak \d.*last/, "no bucket sizes in the details, only the time period");
		assert.match(opened, / {2}▸ r1 /, "other rows stay collapsed");
		viewer.handleInput("\u001b[D");
		assert.match(viewer.render(80).join("\n"), /› ▾ r2 .*\n.*after request 150.*\n.*\(\d+ min\)/, "a compaction point shows its column's period");
		viewer.handleInput("\u001b[C");

		viewer.handleInput("z"); // requests: one column per request, panning
		const opened2 = viewer.render(80).join("\n");
		assert.match(opened2, /z zoom: detail/);
		assert.equal(window(opened2)[1], 300, "the newest requests");
		assert.doesNotMatch(xLabel(opened2), /later/);

		viewer.handleInput("\u001b[D"); // ←: newest compaction point, centred
		const second = viewer.render(80).join("\n");
		const [start, end] = window(second);
		assert.ok(start <= 150 && 150 <= end, `request 150 visible in ${start}–${end}`);
		assert.ok(Math.abs((start + end) / 2 - 150) <= 1, `request 150 centred in ${start}–${end}`);
		assert.match(second, /› ▾ r2 .*\n.*after request 150/);
		viewer.handleInput("\u001b[D"); // ←: first compaction point, window clamped at the start
		assert.equal(window(viewer.render(80).join("\n"))[0], 1);
		viewer.handleInput("\u001b[C");
		viewer.handleInput("\u001b[C"); // → → back to now
		const back = viewer.render(80).join("\n");
		assert.equal(window(back)[1], 300);
		assert.match(back, /› ▾ now/);

		viewer.handleInput("z"); // turns: one column per user turn
		const turns = viewer.render(80).join("\n");
		assert.match(turns, /3 user turns · 1\/column · 300 requests/);
		viewer.handleInput("z"); // back to fit
		assert.match(viewer.render(80).join("\n"), /z zoom: all/);

		viewer.handleInput("\r"); // Enter at now opens the current input
		assert.match(viewer.render(80).join("\n"), /Current input/);
	});

	test("the selected compaction row and its details stay on screen with many edits", () => {
		const points = Array.from({ length: 300 }, (_v, i) => ({ request: i + 1, tokens: 1_000 + i, revision: 0 }));
		const markers = Array.from({ length: 30 }, (_v, i) => ({
			kind: "applied" as const, revision: i + 1, afterPoint: i * 8, beforeTokens: 5_000, afterTokens: 1_000, message: "applied",
		}));
		const base = buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" });
		const model = { ...base, timeline: { points, markers, peakTokens: 1_299, turnStarts: [0, 100, 200] } };
		const viewer = new LiveContextViewer({ terminal: { rows: 24 }, requestRender() {} } as any, theme, model, "overview", () => {}, CLM_VIEW_TABS);
		const opened = viewer.render(80).join("\n");
		assert.match(opened, /› ▾ now/, "the selected now row is visible on open");
		assert.match(opened, /Enter: current input/, "with its details");
		assert.match(opened, /⋯ \d+ earlier/, "rows cut off above are counted");
		assert.match(opened, /Context size · /, "the chart stays on screen");
		viewer.handleInput("\u001b[D");
		const left = viewer.render(80).join("\n");
		assert.match(left, /› ▾ r30 /);
		assert.match(left, /after request 233/);
		viewer.handleInput("k"); // ↑ also selects, the page itself does not scroll
		assert.match(viewer.render(80).join("\n"), /› ▾ r29 /);
		viewer.handleInput("g");
		const first = viewer.render(80).join("\n");
		assert.match(first, /› ▾ r1 /);
		assert.match(first, /⋯ \d+ later/);
	});

	test("overview colors: grey context, blue edits, white selection, yellow only for the budget", () => {
		const points = Array.from({ length: 20 }, (_v, i) => ({ request: i + 1, tokens: 1_000 + i * 100, revision: 0 }));
		const markers = [{ kind: "applied" as const, revision: 1, afterPoint: 9, beforeTokens: 5_000, afterTokens: 1_000, message: "applied" }];
		const base = buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" });
		const model = { ...base, budget: 3_000, timeline: { points, markers, peakTokens: 2_900, turnStarts: [0] } };
		// Zero-width SGR codes per theme color name, so the layout is unchanged.
		const codes: Record<string, number> = { muted: 90, mdLink: 34, text: 97, warning: 33 };
		const tagged = {
			fg: (color: string, text: string) => `\u001b[${codes[color] ?? 37}m${text}\u001b[39m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		} as any;
		const esc = "\u001b\\[";
		const viewer = new LiveContextViewer({ terminal: { rows: 40 }, requestRender() {} } as any, tagged, model, "overview", () => {}, CLM_VIEW_TABS);
		const text = viewer.render(120).join("\n");
		assert.match(text, new RegExp(`${esc}90m█+`), "context bars are grey");
		assert.match(text, new RegExp(`${esc}34m▓+`), "edited columns are blue");
		assert.match(text, new RegExp(`${esc}34m\\s*▿`), "edit markers are blue");
		assert.match(text, new RegExp(`${esc}1m${esc}97m█+`), "the selected (now) column is bold white");
		assert.match(text, new RegExp(`${esc}33m╌+`), "the budget line stays yellow");
		assert.doesNotMatch(text, new RegExp(`${esc}33m\\s*[█▓▿▼]`), "yellow is not used for bars or markers");
		assert.match(text, new RegExp(`${esc}34m {2}▸ r1 `), "accepted edits are blue in the list");
		viewer.handleInput("\u001b[D");
		assert.match(viewer.render(120).join("\n"), new RegExp(`${esc}1m${esc}34m\\s*▼`), "the selected edit's marker is bold blue");
	});

	test("settings page: cycle choices, type values in a prompt, show errors; panel keys still work", () => {
		const values: Record<string, string> = { editing: "on", budget: "model window (1m)", guard: "on" };
		const applied: Array<[string, string]> = [];
		const controller = {
			items: () => [
				{ id: "editing", label: "CLM editing", value: values.editing!, choices: ["on", "off"], description: "Master switch." },
				{ id: "budget", label: values.budget === "200k" ? "Budget •" : "Budget", value: values.budget!, placeholder: "200k, or window", description: "Token budget." },
				{ id: "guard", label: "Overflow guard", value: values.guard!, choices: ["on", "off"], description: "Withhold oldest tool results." },
			],
			apply: (id: string, value: string) => {
				applied.push([id, value]);
				if (value === "lots") return "expected a number of tokens like 200k";
				values[id] = value;
				return undefined;
			},
			summary: () => ["Size      next request ~346k of 1m"],
		};
		const base = buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" });
		let closed = false;
		const viewer = new LiveContextViewer({ terminal: { rows: 40 }, requestRender() {} } as any, theme, base, "overview", () => { closed = true; }, CLM_VIEW_TABS, controller);
		assert.match(viewer.render(100).join("\n"), /\[1:overview\].*4:settings/);
		viewer.handleInput("4");
		let page = viewer.render(100).join("\n");
		assert.match(page, /Settings · changes apply now and are saved in this session/);
		assert.match(page, /Size {6}next request ~346k of 1m/);
		assert.match(page, /› CLM editing +on/);
		assert.match(page, /Master switch\./, "the selected row's description is shown");

		viewer.handleInput("\u001b[B"); // ↓ budget
		viewer.handleInput("\r"); // opens the text prompt
		page = viewer.render(100).join("\n");
		assert.match(page, /Budget · currently model window \(1m\)/);
		for (const key of "q2") viewer.handleInput(key); // typed into the prompt, not panel keys
		assert.equal(closed, false);
		viewer.handleInput("\u007f"); viewer.handleInput("\u007f");
		for (const key of "200k") viewer.handleInput(key);
		viewer.handleInput("\r");
		assert.deepEqual(applied.at(-1), ["budget", "200k"]);
		return Promise.resolve().then(() => {
			page = viewer.render(100).join("\n");
			assert.match(page, /› Budget • +200k/, "rebuilt with the new value and the changed marker");
			assert.match(page, /✓ Budget: 200k/);

			viewer.handleInput("\r"); // the prompt starts with the current value
			assert.match(viewer.render(100).join("\n"), /200k/);
			for (let i = 0; i < 4; i++) viewer.handleInput("\u007f");
			for (const key of "lots") viewer.handleInput(key);
			viewer.handleInput("\r");
			return Promise.resolve();
		}).then(() => {
			page = viewer.render(100).join("\n");
			assert.match(page, /⚠ expected a number of tokens/);
			assert.match(page, /› Budget • +200k/, "a rejected change keeps the value in effect");

			viewer.handleInput("j"); // guard
			viewer.handleInput(" "); // cycles on → off
			assert.deepEqual(applied.at(-1), ["guard", "off"]);
			viewer.handleInput("\t");
			assert.match(viewer.render(100).join("\n"), /\[1:overview\]/, "Tab still switches pages");
			viewer.handleInput("4");
			viewer.handleInput("q");
			assert.equal(closed, true);
		});
	});

	test("settings page keeps the selected setting and its description on screen in small terminals", () => {
		const items = Array.from({ length: 12 }, (_v, i) => ({
			id: `s${i}`,
			label: i === 3 ? "Setting 3 •" : `Setting ${i}`,
			value: i === 3 ? "200k" : "off",
			...(i === 3 ? { placeholder: "200k, or window" } : { choices: ["off", "on"] }),
			description: `Description of setting ${i}. ${"It explains what the setting does and which environment variable sets it. ".repeat(2)}`,
		}));
		const controller = {
			items: () => items,
			apply: () => undefined,
			summary: () => [
				"Size      next request ~346k of 1m · last request 345.5k (provider count)",
				"          estimate ×1.81, calibrated from 214 provider counts",
				"Guard     withholds the oldest tool results above 994k · Pi's automatic compaction paused",
				"Files     mirror …/pi-live-context-01a0ebe3…/LIVE_CONTEXT.md (full path: /clm path)",
				"          annotations none",
			],
		};
		const base = buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" });
		for (const [width, rows] of [[60, 24], [80, 20], [60, 16], [120, 40]] as const) {
			const viewer = new LiveContextViewer({ terminal: { rows }, requestRender() {} } as any, theme, base, "settings", () => {}, CLM_VIEW_TABS, controller);
			for (let i = 0; i < items.length; i++) {
				const frame = viewer.render(width).join("\n");
				assert.match(frame, new RegExp(`› Setting ${i} `), `${width}×${rows}: setting ${i} is selected and on screen`);
				assert.match(frame, new RegExp(`Description of setting ${i}\\.`), `${width}×${rows}: its description is on screen`);
				viewer.handleInput("\u001b[B");
			}
		}

		// A resize rebuilds the list for the new size and keeps the selection (read back from the
		// styled rendering), and the open text prompt stays on screen too.
		const styled = {
			fg: (color: string, text: string) => `\u001b[38;5;${color.length}m${text}\u001b[39m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
		} as any;
		const plain = (lines: string[]) => stripTerminalSequences(lines.join("\n"));
		const terminal = { rows: 40 };
		const viewer = new LiveContextViewer({ terminal, requestRender() {} } as any, styled, base, "settings", () => {}, CLM_VIEW_TABS, controller);
		viewer.render(120);
		for (let i = 0; i < 3; i++) viewer.handleInput("\u001b[B");
		terminal.rows = 16;
		assert.match(plain(viewer.render(60)), /› Setting 3 •/);
		viewer.handleInput("\t");
		viewer.render(60);
		viewer.handleInput("4"); // back to settings: the selection and its description again
		const back = plain(viewer.render(60));
		assert.match(back, /› Setting 3 •/);
		assert.match(back, /Description of setting 3\./);
		viewer.handleInput("\r");
		const prompt = plain(viewer.render(60));
		assert.match(prompt, /Setting 3 · currently 200k/);
		assert.match(prompt, /> 200k/, "the prompt's input line is on screen");
	});

	test("the settings page is only offered with a controller", () => {
		const base = buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" });
		const viewer = new LiveContextViewer({ terminal: { rows: 40 }, requestRender() {} } as any, theme, base, "overview", () => {}, CLM_VIEW_TABS);
		assert.doesNotMatch(viewer.render(100).join("\n"), /settings/);
	});

	test("windowAroundSelection keeps the selected group and marks what is cut off", () => {
		const groups = Array.from({ length: 10 }, (_v, i) => i === 6 ? [`row ${i}`, "detail a", "detail b"] : [`row ${i}`]);
		const more = (count: number, where: string) => `… ${count} ${where}`;
		assert.deepEqual(windowAroundSelection(groups, 6, 100, more).length, 12, "everything fits");
		const window = windowAroundSelection(groups, 6, 7, more);
		assert.ok(window.length <= 7);
		assert.ok(window.includes("row 6") && window.includes("detail b"));
		assert.match(window[0]!, /^… \d+ earlier$/);
		assert.match(window.at(-1)!, /^… \d+ later$/);
		const tiny = windowAroundSelection(groups, 6, 1, more);
		assert.ok(tiny.includes("row 6"), "the selection wins even when nothing else fits");
	});

	test("a short branch has no zoom-in: fit is already one column per request", () => {
		const points = Array.from({ length: 20 }, (_v, i) => ({ request: i + 1, tokens: 1_000 + i * 100, revision: 0 }));
		const base = buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" });
		const model = { ...base, timeline: { points, markers: [], peakTokens: 2_900, turnStarts: [0, 10] } };
		const viewer = new LiveContextViewer({ terminal: { rows: 40 }, requestRender() {} } as any, theme, model, "overview", () => {}, CLM_VIEW_TABS);
		const opened = viewer.render(80).join("\n");
		assert.match(opened, /all 20 requests(?! ·)/);
		assert.match(opened, /z zoom: all/);
		viewer.handleInput("z");
		assert.match(viewer.render(80).join("\n"), /z zoom: turns/, "requests is skipped: it would be identical to fit");
		viewer.handleInput("z");
		assert.match(viewer.render(80).join("\n"), /z zoom: all/);
	});

	test("keeps the selected edit row visible when rows expand to multiple lines", () => {
		const edits = Array.from({ length: 24 }, (_value, index) => ({
			kind: "removed" as const,
			sourceIndex: index + 1,
			beforeRole: "toolResult",
			beforeTokens: 50,
			beforePreview: `preview ${index + 1}`,
			beforeDetail: `first line ${index + 1}\nsecond line ${index + 1}\nthird line ${index + 1}`,
		}));
		const model: LiveContextViewModel = {
			enabled: true,
			revision: 1,
			beforeEstimate: 100,
			afterEstimate: 50,
			savingsEstimate: 50,
			estimateUnit: "tokens",
			savingsPercent: 50,
			rawMessageCount: 24,
			effectiveMessageCount: 24,
			suffixMessageCount: 0,
			snapshotStale: false,
			messages: [],
			timeline: { points: [], markers: [], peakTokens: 0 },
			edits,
			editTraceSource: "recorded",
			editRevisions: [{ revision: 1, sourceRevision: 0, beforeTokens: 100, afterTokens: 50, edits, traceSource: "recorded" }],
			tree: [],
			treeHiddenEntryCount: 0,
			history: [],
			runtime: { kind: "standalone", sessionId: "session", mode: "tui" },
		};
		const tui = { terminal: { rows: 20 }, requestRender: () => {} } as any;
		const viewer = new LiveContextViewer(tui, theme, model, "edit", () => {});
		viewer.render(80);
		viewer.handleInput("a");
		viewer.render(80);
		for (let step = 0; step < 23; step++) viewer.handleInput("j");
		const visible = viewer.render(80).join("\n");
		assert.match(visible, /› ▾ .*#24/);
	});

	test("does not claim identical text when changes are beyond the diff preview limit", () => {
		const prefix = "same line\n".repeat(6_500);
		const source = [{ role: "user", content: prefix + "old tail", timestamp: 1 }];
		const output = [{ role: "user", content: prefix + "new tail", timestamp: 1 }];
		const checkpoint = createProjectionCheckpoint({
			revision: 1, sourceMessages: source, projectedMessages: output,
			beforeEstimate: 20_000, afterEstimate: 20_000, estimateUnit: "tokens",
			editTrace: { version: 1, sourceRevision: 0, sourceMessageCount: 1, outputMessageCount: 1,
				sources: [{ sourceIndex: 0, outputIndex: 0, kind: "edited" }], additions: [] },
		});
		const state: LiveContextState = { version: 1, enabled: true, revision: 1, checkpoint };
		const model = buildLiveContextViewModel({ state,
			entries: [{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state }],
			rawMessages: source, sessionId: "session", mode: "tui" });
		const viewer = new LiveContextViewer({ terminal: { rows: 30 }, requestRender() {} } as any, theme, model, "edit", () => {});
		viewer.handleInput("\r");
		const text = viewer.render(120).join("\n");
		// The diff runs on the full text, so a change past 64k characters is shown, not hidden.
		assert.doesNotMatch(text, /no text change/);
		assert.match(text, /6501 old tail\s+~ 6501 new tail/);
		assert.match(text, /⋯ 6497 unchanged lines/);
	});

	test("bounds huge replaced blocks with an explicit truncation row", () => {
		const edits = [{
			kind: "edited" as const,
			sourceIndex: 1,
			outputIndex: 1,
			beforeRole: "toolResult",
			afterRole: "toolResult",
			beforeTokens: 9_000,
			afterTokens: 9_000,
			beforeText: Array.from({ length: 2_000 }, (_v, i) => `old ${i}`).join("\n"),
			afterText: Array.from({ length: 2_000 }, (_v, i) => `new ${i}`).join("\n"),
		}];
		const model = {
			...buildLiveContextViewModel({ state: projectedState(), entries: [], rawMessages: raw, sessionId: "session", mode: "tui" }),
			editRevisions: [{ revision: 1, sourceRevision: 0, beforeTokens: 9_000, afterTokens: 9_000, edits, traceSource: "recorded" as const }],
		};
		const viewer = new LiveContextViewer({ terminal: { rows: 30 }, requestRender() {} } as any, theme, model, "edit", () => {});
		viewer.handleInput("\r");
		viewer.handleInput("G");
		const text = viewer.render(120).join("\n");
		assert.match(text, /diff preview truncated: 1600 more lines not shown/);
	});

	test("invalidates cached diff colors when the theme changes", () => {
		const state = projectedState();
		const model = buildLiveContextViewModel({ state,
			entries: [{ type: "custom", customType: LIVE_CONTEXT_STATE, data: state }],
			rawMessages: raw, sessionId: "session", mode: "tui" });
		let color = "31";
		const changingTheme = { ...theme, fg: (_name: string, text: string) => `\x1b[${color}m${text}\x1b[39m` };
		const viewer = new LiveContextViewer({ terminal: { rows: 30 }, requestRender() {} } as any, changingTheme, model, "edit", () => {});
		viewer.render(120);
		viewer.handleInput("j");
		viewer.handleInput("\r");
		assert.match(viewer.render(120).join("\n"), /\x1b\[31m/);
		color = "32";
		viewer.invalidate();
		const refreshed = viewer.render(120).join("\n");
		assert.match(refreshed, /\x1b\[32m/);
		assert.doesNotMatch(refreshed, /\x1b\[31m/);
	});

	test("expanded edits show a side-by-side diff that fits the width and scrolls", () => {
		const beforeText = Array.from({ length: 60 }, (_v, i) => `note line ${i + 1}`).join("\n");
		const afterText = beforeText.replace("note line 30", "note line thirty (updated)");
		const edits = [
			{
				kind: "edited" as const,
				sourceIndex: 1,
				outputIndex: 1,
				beforeRole: "notes",
				afterRole: "notes",
				beforeTokens: 200,
				afterTokens: 201,
				beforeDetail: beforeText.slice(0, 40),
				afterDetail: afterText.slice(0, 40),
				beforeText,
				afterText,
			},
			{
				kind: "removed" as const,
				sourceIndex: 2,
				beforeRole: "toolResult",
				beforeTokens: 30,
				beforeDetail: Array.from({ length: 40 }, (_v, i) => `output row ${i + 1}`).join("\n"),
			},
			{ kind: "added" as const, outputIndex: 2, afterRole: "notes", afterTokens: 5, afterDetail: "fresh summary" },
		];
		const model: LiveContextViewModel = {
			enabled: true,
			revision: 1,
			beforeEstimate: 230,
			afterEstimate: 206,
			savingsEstimate: 24,
			estimateUnit: "tokens",
			savingsPercent: 10,
			rawMessageCount: 2,
			effectiveMessageCount: 2,
			suffixMessageCount: 0,
			snapshotStale: false,
			messages: [],
			timeline: { points: [], markers: [], peakTokens: 0 },
			edits,
			editTraceSource: "recorded",
			editRevisions: [{ revision: 1, sourceRevision: 0, beforeTokens: 230, afterTokens: 206, edits, traceSource: "recorded" }],
			tree: [],
			treeHiddenEntryCount: 0,
			history: [],
			runtime: { kind: "standalone", sessionId: "session", mode: "tui" },
		};
		const viewer = new LiveContextViewer({ terminal: { rows: 30 }, requestRender() {} } as any, theme, model, "edit", () => {});
		viewer.handleInput("\r");
		const wide = viewer.render(120);
		assert.ok(wide.every((line) => visibleWidth(line) <= 120));
		const text = wide.join("\n");
		assert.match(text, /before · #1 notes · 200 tok\s+│ after · #1 notes · 201 tok/);
		// The change is on line 30, past the collapsed detail: the diff uses the full text.
		assert.match(text, /30 note line 30\s+~ 30 note line thirty \(updated\)/);
		assert.match(text, /⋯ 26 unchanged lines/);

		viewer.handleInput("j");
		viewer.handleInput("\r");
		const removed = viewer.render(120).join("\n");
		assert.match(removed, /1 output row 1\s+−\s+\(removed from the next request\)/);
		// ↓ scrolls through the long removed block before moving to the next row.
		const before = viewer.render(120).join("\n");
		for (let step = 0; step < 12; step++) viewer.handleInput("j");
		const scrolled = viewer.render(120).join("\n");
		assert.notEqual(scrolled, before);
		assert.match(scrolled, /› ▾ − #2 toolResult|output row 2\d/);
		assert.doesNotMatch(scrolled, /› ▸ \+/);

		const narrow = viewer.render(50);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 50));
		assert.match(narrow.join("\n"), /-\s*\d+ output row/);
	});

	test("keeps the selected tree row and its expansion visible in a long narrow tree", () => {
		const state = projectedState();
		const base = buildLiveContextViewModel({
			state,
			entries: [],
			rawMessages: raw,
			sessionId: "session",
			mode: "tui",
		});
		const tree: typeof base.tree = Array.from({ length: 30 }, (_value, index) => ({
			entryId: `turn-${index + 1}`,
			prefix: index === 0 ? "" : "└─ ",
			active: true,
			head: index === 29,
			kind: "turn",
			text: `T${index + 1} · user · ${"long preview ".repeat(10)}`,
			status: "all effective",
			details: [index === 29 ? "EXPANDED DETAIL FOR CURRENT TURN" : `detail ${index + 1}`],
		}));
		const viewer = new LiveContextViewer(
			{ terminal: { rows: 18 }, requestRender() {} } as any,
			theme,
			{ ...base, tree },
			"tree",
			() => {},
		);

		const collapsed = viewer.render(56);
		assert.ok(collapsed.every((line) => visibleWidth(line) <= 56));
		assert.match(collapsed.join("\n"), /›▸ ●←\s+└─ T30/);
		const selectedScreenLine = collapsed.findIndex((line) => /T30/.test(line));
		for (let cycle = 0; cycle < 8; cycle++) {
			viewer.handleInput("\r");
			const expanded = viewer.render(56);
			assert.ok(expanded.every((line) => visibleWidth(line) <= 56));
			assert.match(expanded.join("\n"), /›▾ ●←\s+└─ T30/);
			assert.match(expanded.join("\n"), /EXPANDED DETAIL FOR CURRENT TURN/);
			assert.equal(expanded.findIndex((line) => /T30/.test(line)), selectedScreenLine);
			viewer.handleInput("\r");
			const collapsedAgain = viewer.render(56).join("\n");
			assert.match(collapsedAgain, /›▸ ●←\s+└─ T30/);
			assert.doesNotMatch(collapsedAgain, /EXPANDED DETAIL FOR CURRENT TURN/);
			assert.equal(collapsedAgain.split("\n").findIndex((line) => /T30/.test(line)), selectedScreenLine);
		}
	});
});
