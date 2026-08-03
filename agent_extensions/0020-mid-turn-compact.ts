/**
 * Mid-turn threshold compaction (opt-in).
 *
 * Stock pi only runs soft-threshold auto-compaction after `agent_end` (and
 * before the next prompt). Long tool loops can therefore overshoot the soft
 * window until hard overflow. This extension interrupts at `turn_end` when
 * tool work is still pending: it aborts the active run, lets pi finish its
 * normal post-run compaction check, then falls back to public `ctx.compact()`
 * only if context usage is still over the soft threshold at `agent_settled`.
 *
 * There is no public in-run `agent.continue()`: both this flow and direct
 * `ctx.compact()` end the active run. Resume is therefore a synthetic user
 * nudge via `pi.sendUserMessage` so the same task can continue after compact.
 *
 * Enable with `/mid-turn-compact enable`. Default: disabled.
 *
 * Soft threshold matches core pi:
 *   tokens > contextWindow - reserveTokens  (default reserve 16384)
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT — tool-call / tool-result integrity with server compaction (0017)
 * ---------------------------------------------------------------------------
 *
 * This extension only chooses *when* to compact. When 0017 owns the compact
 * boundary (openai-codex / qualified Responses mirrors), the *how* preserves
 * call/result pairing. That property is load-bearing for mid-turn use and
 * must not be broken by alternate compact strategies.
 *
 * Compact REQUEST (what leaves the client toward the server):
 *   prepared inference-shaped Responses `input` (last payload snapshot)
 *   + branch tail after that snapshot leaf (tool results that landed after
 *     the sample that issued the tool calls)
 *   + { type: "compaction_trigger" }   // Codex adapter
 *
 * So large tool results are sent to server-side compaction **uncompressed**,
 * **together with** the assistant tool-call items (and the rest of the
 * pre-compact history). We do *not* strip bodies client-side before compact.
 *
 * Compact RESULT / next model request (open window after success):
 *   retainRecentUserItems(that input)  // recent USER messages only
 *   + encrypted compaction artifact    // sealed stand-in for everything else
 *   + only session messages AFTER the new compaction entry
 *
 * Therefore the next sample is NOT the broken split:
 *   [compacted/sealed history ending mid-turn with a tool_call]
 *   + [that same call's tool_result still open and uncompacted]
 *
 * Cut-region tool_call and tool_result pairs both go into the compact input
 * as full wire items and afterward both live only inside the opaque artifact
 * (plus retained users outside). Call/result integrity is preserved; precise
 * open tool-result text is not (that is intentional server compaction).
 *
 * Pi `firstKeptEntryId` / keepRecent still decide the session-tree cut for
 * readable context; 0017 provider replay uses replacementHistory + tail after
 * the compaction node, not "artifact + half-open firstKept tool results."
 * Pi never cuts *on* a bare toolResult either (valid cut = user/assistant/…).
 *
 * If compact is implemented without 0017 (readable local summarizer), the
 * same turn_end timing applies, but the server-artifact pairing story above
 * does not — readable summaries replace cut history with text, not ciphertext.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

/** Default reserve tokens; matches pi CompactionSettings.reserveTokens. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** Synthetic resume prompt after mid-turn compact. Sent as a real user message. */
export const MID_TURN_CONTINUE_PROMPT =
	"[mid-turn-compact] Context was compacted mid-task. Continue the current task from the latest tool results without restarting the goal.";

export const COMMAND_NAME = "mid-turn-compact";

/** Footer status key for ctx.ui.setStatus (sibling to session stats / last-turn). */
export const FOOTER_STATUS_KEY = "mid-turn-compact";

/** Footer chip when mid-turn compact is enabled. */
export const FOOTER_STATUS_ON = "midturn-compact: on";

/** Footer chip when mid-turn compact is disabled. */
export const FOOTER_STATUS_OFF = "midturn-compact: off";

export type MidTurnCompactStatus = {
	enabled: boolean;
	inFlight: boolean;
	compactsThisRun: number;
};

/**
 * Footer chip text beside session stats.
 * Exported for unit tests.
 */
export function renderFooterStatus(enabled: boolean): string {
	return enabled ? FOOTER_STATUS_ON : FOOTER_STATUS_OFF;
}

/**
 * Soft-threshold check matching pi `shouldCompact`.
 * Exported for unit tests.
 */
export function isOverSoftThreshold(
	tokens: number | null | undefined,
	contextWindow: number | null | undefined,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): boolean {
	if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return false;
	if (contextWindow === null || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return false;
	}
	return tokens > contextWindow - reserveTokens;
}

/**
 * Whether this turn_end should trigger mid-turn compact when enabled.
 * T1: only when tool results were produced (tools still need a follow-up sample).
 * Exported for unit tests.
 */
export function shouldTriggerMidTurnCompact(options: {
	enabled: boolean;
	inFlight: boolean;
	toolResultCount: number;
	tokens: number | null | undefined;
	contextWindow: number | null | undefined;
	reserveTokens?: number;
}): boolean {
	if (!options.enabled) return false;
	if (options.inFlight) return false;
	if (options.toolResultCount <= 0) return false;
	return isOverSoftThreshold(options.tokens, options.contextWindow, options.reserveTokens);
}

function parseCommandArgs(args: string): "enable" | "disable" | "status" | "help" {
	const first = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (first === "enable" || first === "on" || first === "1" || first === "true") return "enable";
	if (first === "disable" || first === "off" || first === "0" || first === "false") return "disable";
	if (first === "status" || first === "") return "status";
	return "help";
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default function midTurnCompact(pi: ExtensionAPI): void {
	let enabled = false;
	let inFlight = false;
	let compactsThisRun = 0;

	const resetRunCounters = (): void => {
		inFlight = false;
		compactsThisRun = 0;
	};

	const status = (): MidTurnCompactStatus => ({
		enabled,
		inFlight,
		compactsThisRun,
	});

	const formatStatus = (): string => {
		const s = status();
		return [
			`mid-turn-compact: ${s.enabled ? "enabled" : "disabled"}`,
			`in-flight: ${s.inFlight ? "yes" : "no"}`,
			`compacts this interaction: ${s.compactsThisRun}`,
		].join("; ");
	};

	const pushFooterStatus = (ctx: ExtensionContext | ExtensionCommandContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, renderFooterStatus(enabled));
	};

	const clearFooterStatus = (ctx: ExtensionContext | ExtensionCommandContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
	};

	const resumeTask = (ctx: ExtensionContext, note: string): void => {
		try {
			pi.sendUserMessage(MID_TURN_CONTINUE_PROMPT);
			notify(ctx, note, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Mid-turn compact resume failed: ${message}`, "error");
		} finally {
			inFlight = false;
		}
	};

	const startMidTurnBoundary = (ctx: ExtensionContext): void => {
		inFlight = true;
		compactsThisRun += 1;
		notify(ctx, `Mid-turn compact boundary starting (#${compactsThisRun})…`, "info");
		// Interrupt before the next model sample, but do not race pi's post-run
		// auto-compaction with a delayed manual compact. agent_settled runs only
		// after pi has completed its retry/compaction lifecycle.
		ctx.abort();
	};

	const compactAfterSettlement = (ctx: ExtensionContext): void => {
		// Consume this settlement before starting the fire-and-forget fallback.
		// A compacted context reports tokens:null until its next assistant turn;
		// that is evidence that pi already owned this forced boundary.
		inFlight = false;
		const usage = ctx.getContextUsage();
		if (!isOverSoftThreshold(usage?.tokens, usage?.contextWindow)) {
			resumeTask(ctx, "Mid-turn compact done; resuming task.");
			return;
		}

		// Pi did not compact (most commonly because the new tool results, rather
		// than the preceding assistant usage, crossed the threshold). Use its
		// public manual boundary now that the agent is fully settled. Wire shape
		// and call/result pairing under server compaction remain 0017's concern.
		ctx.compact({
			onComplete: () => {
				resumeTask(ctx, "Mid-turn compact done; resuming task.");
			},
			onError: () => {
				// Pi already renders compaction_end failures. Resume without emitting a
				// second copy of the same error.
				resumeTask(ctx, "Mid-turn compact failed; resuming without compaction.");
			},
		});
	};

	// Keep an informational count across synthetic resumes; a real user prompt
	// starts a new outer interaction and resets the display count.
	pi.on("before_agent_start", (event) => {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (prompt !== MID_TURN_CONTINUE_PROMPT) compactsThisRun = 0;
	});

	pi.on("session_start", (event, ctx) => {
		resetRunCounters();
		pushFooterStatus(ctx);
	});
	pi.on("session_tree", resetRunCounters);
	pi.on("model_select", resetRunCounters);
	pi.on("session_shutdown", (_event, ctx) => {
		resetRunCounters();
		clearFooterStatus(ctx);
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const toolResultCount = event.toolResults?.length ?? 0;
		if (
			!shouldTriggerMidTurnCompact({
				enabled,
				inFlight,
				toolResultCount,
				tokens: usage?.tokens,
				contextWindow: usage?.contextWindow,
			})
		) {
			return;
		}
		startMidTurnBoundary(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!inFlight) return;
		compactAfterSettlement(ctx);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Enable/disable mid-turn soft-threshold compaction (enable|disable|status)",
		handler: async (args, ctx) => {
			const action = parseCommandArgs(args);
			switch (action) {
				case "enable":
					enabled = true;
					pushFooterStatus(ctx);
					notify(ctx, "Mid-turn compact enabled. Soft threshold fires at turn_end when tools are pending.", "info");
					return;
				case "disable":
					enabled = false;
					inFlight = false;
					pushFooterStatus(ctx);
					notify(ctx, "Mid-turn compact disabled.", "info");
					return;
				case "status":
					pushFooterStatus(ctx);
					notify(ctx, formatStatus(), "info");
					return;
				default:
					notify(
						ctx,
						"Usage: /mid-turn-compact enable|disable|status",
						"warning",
					);
			}
		},
	});
}
