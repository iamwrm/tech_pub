/**
 * Last-prompt stats: footer status line + /last-turn command.
 *
 * Shows token/cost stats for the last prompt cycle (the messages produced
 * since the most recent user prompt), unlike pi's built-in footer stats
 * which cover the whole session.
 *
 * - Footer status, mirroring pi's built-in footer format:
 *     last 1m12s ↑14 ↓3.7k R154k W39k CH94.2% $0.823 claude-fable-5 • high
 *   (wall-clock duration of the prompt cycle, ↑ input, ↓ output,
 *   R cache read, W cache write, CH cache hit ratio, $ cost,
 *   model(s) used • thinking level)
 *   Duration leads so the live line transitions naturally from
 *   duration-only (before the first turn completes) to full stats.
 *
 *   Timeline of one prompt cycle in the footer:
 *
 *     last 0s claude-fable-5 • high                             ← agent_start (ticker begins)
 *     last 1s claude-fable-5 • high                             ← duration ticks every second
 *     ...
 *     last 11s ↑2 ↓51 R5.3k CH100.0% $0.008 claude-fable-5 • high   ← turn 1 completes
 *     last 12s ↑2 ↓51 R5.3k CH100.0% $0.008 claude-fable-5 • high   ← keeps ticking (tool running)
 *     ...
 *     last 15s ↑4 ↓54 R11k CH100.0% $0.013 claude-fable-5 • high    ← agent_end: frozen at
 *                                                                  final totals (stays until
 *                                                                  the next prompt)
 *   While a prompt is RUNNING the line updates semi-realtime: the duration
 *   ticks every second and token/cost stats refresh after every completed
 *   LLM turn, so long multi-tool runs can be monitored live. When the
 *   prompt finishes the line freezes at the final totals.
 * - /last-turn prints a detailed breakdown into the transcript (display-only,
 *   never sent to the LLM).
 *
 * Completed-prompt stats are always derived on demand from the *active
 * branch* of the session (ctx.sessionManager.getBranch()), so they stay
 * correct across /tree branch switches, session restores, and forks without
 * any persisted extension state. The live view of the running prompt uses a
 * turn_end accumulator that is discarded at agent_end in favor of the
 * branch-derived truth.
 *
 * Cache hit ratio = Σ cacheRead / Σ (input + cacheRead + cacheWrite) over the
 * prompt cycle's assistant messages — the same formula pi's footer uses for
 * its latest-turn cache hit rate, aggregated across the cycle.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** Aggregated usage for one prompt cycle. Exported for smoke tests. */
export interface LastPromptStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Number of assistant messages (LLM turns) in the cycle. */
	turns: number;
	/** Unique `provider/model` identifiers used in the cycle. */
	models: string[];
	/** ms epoch of the user prompt entry (or first assistant entry when absent). */
	startTime: number | null;
	/** ms epoch of the last assistant entry. */
	endTime: number | null;
	/** Thinking level in effect for the cycle, when known. */
	thinkingLevel: string | null;
}

function entryTimeMs(entry: SessionEntry): number | null {
	const t = Date.parse(entry.timestamp);
	return Number.isFinite(t) ? t : null;
}

function readNum(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Compute stats for the last prompt cycle on a branch: find the last
 * assistant message, then the last user prompt before it, and aggregate all
 * assistant messages after that boundary. Returns null when the branch has
 * no assistant messages yet. Exported for smoke tests.
 */
export function computeLastPromptStats(entries: SessionEntry[]): LastPromptStats | null {
	let lastAssistantIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && (entry.message as { role?: unknown })?.role === "assistant") {
			lastAssistantIndex = i;
			break;
		}
	}
	if (lastAssistantIndex === -1) return null;

	// Thinking level in effect for the cycle: the latest change entry at or
	// before the last assistant message. Sessions that never changed the level
	// have no such entry; callers fall back to the current level.
	let thinkingLevel: string | null = null;
	for (let i = lastAssistantIndex; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
			break;
		}
	}

	// The user prompt that started the cycle. A steering/follow-up user
	// message queued mid-run moves this boundary; acceptable simplification.
	let boundaryIndex = -1;
	for (let i = lastAssistantIndex - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && (entry.message as { role?: unknown })?.role === "user") {
			boundaryIndex = i;
			break;
		}
	}

	const stats = emptyStats(boundaryIndex >= 0 ? entryTimeMs(entries[boundaryIndex]) : null);
	stats.thinkingLevel = thinkingLevel;

	for (let i = boundaryIndex + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		if (!accumulateAssistantMessage(stats, entry.message)) continue;

		const t = entryTimeMs(entry);
		if (t !== null) {
			if (stats.startTime === null) stats.startTime = t;
			stats.endTime = t;
		}
	}

	return stats.turns > 0 ? stats : null;
}

/** Fresh all-zero stats. Exported for smoke tests. */
export function emptyStats(startTime: number | null): LastPromptStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		models: [],
		startTime,
		endTime: null,
		thinkingLevel: null,
	};
}

/**
 * Add one assistant message's usage into `stats`. Returns false (and does
 * nothing) for non-assistant/malformed messages. Exported for smoke tests.
 */
export function accumulateAssistantMessage(stats: LastPromptStats, message: unknown): boolean {
	const m = message as {
		role?: unknown;
		provider?: unknown;
		model?: unknown;
		usage?: {
			input?: unknown;
			output?: unknown;
			cacheRead?: unknown;
			cacheWrite?: unknown;
			cost?: { total?: unknown };
		};
	};
	if (m?.role !== "assistant") return false;

	stats.turns += 1;
	const usage = m.usage;
	stats.input += readNum(usage?.input);
	stats.output += readNum(usage?.output);
	stats.cacheRead += readNum(usage?.cacheRead);
	stats.cacheWrite += readNum(usage?.cacheWrite);
	stats.cost += readNum(usage?.cost?.total);

	const provider = typeof m.provider === "string" ? m.provider : "";
	const model = typeof m.model === "string" ? m.model : "";
	const id = provider && model ? `${provider}/${model}` : provider || model;
	if (id && !stats.models.includes(id)) stats.models.push(id);
	return true;
}

/** Prompt-side cache hit ratio in percent, or null when no cache activity. */
export function cacheHitPercent(stats: LastPromptStats): number | null {
	if (stats.cacheRead <= 0 && stats.cacheWrite <= 0) return null;
	const promptTokens = stats.input + stats.cacheRead + stats.cacheWrite;
	return promptTokens > 0 ? (stats.cacheRead / promptTokens) * 100 : null;
}

/** Same thresholds as pi's built-in footer formatTokens. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** 42s · 1m12s · 1h05m. Exported for smoke tests. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** `provider/model` → `model`, joined for multi-model cycles. */
function displayModels(models: string[]): string {
	return models
		.map((m) => {
			const idx = m.indexOf("/");
			return idx === -1 ? m : m.slice(idx + 1);
		})
		.join(",");
}

function durationOf(stats: LastPromptStats): string | null {
	if (stats.startTime === null || stats.endTime === null || stats.endTime < stats.startTime) return null;
	return formatDuration(stats.endTime - stats.startTime);
}

/** Footer status line, mirroring pi's built-in session stats format. Exported for smoke tests. */
export function renderStatusLine(stats: LastPromptStats): string {
	const parts: string[] = [];
	const duration = durationOf(stats);
	if (duration) parts.push(duration);
	if (stats.input) parts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output) parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
	if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
	const hit = cacheHitPercent(stats);
	if (hit !== null) parts.push(`CH${hit.toFixed(1)}%`);
	if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
	if (stats.models.length > 0) {
		const models = displayModels(stats.models);
		parts.push(stats.thinkingLevel ? `${models} • ${stats.thinkingLevel}` : models);
	}
	return `last ${parts.join(" ")}`;
}

/** Detailed transcript block for /last-turn. Exported for smoke tests. */
export function renderDetails(stats: LastPromptStats): string {
	const fmt = (n: number) => n.toLocaleString("en-US");
	const hit = cacheHitPercent(stats);
	const lines = [
		"Last prompt stats",
		`  tokens in:    ${fmt(stats.input)}`,
		`  tokens out:   ${fmt(stats.output)}`,
		`  cache read:   ${fmt(stats.cacheRead)}`,
		`  cache write:  ${fmt(stats.cacheWrite)}`,
		`  cache hit:    ${hit !== null ? `${hit.toFixed(1)}%` : "n/a"}`,
		`  cost:         $${stats.cost.toFixed(4)}`,
	];
	const tail = [`${stats.turns} ${stats.turns === 1 ? "turn" : "turns"}`];
	const duration = durationOf(stats);
	if (duration) tail.push(`duration ${duration}`);
	if (stats.models.length > 0) tail.push(stats.models.join(", "));
	lines.push(`  turns:        ${tail.join(" · ")}`);
	return lines.join("\n");
}

/** Ticker period for the live (running-prompt) status refresh. */
export const LIVE_TICK_MS = 1000;

export default function lastTurnExtension(pi: ExtensionAPI) {
	// Accumulator for the currently running prompt cycle; null when idle.
	let live: LastPromptStats | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;

	const stopTicker = () => {
		if (ticker !== null) {
			clearInterval(ticker);
			ticker = null;
		}
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const stats = computeLastPromptStats(ctx.sessionManager.getBranch());
		if (stats && stats.thinkingLevel === null) stats.thinkingLevel = pi.getThinkingLevel();
		ctx.ui.setStatus("last-turn", stats ? renderStatusLine(stats) : undefined);
	};

	const pushLive = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !live) return;
		ctx.ui.setStatus("last-turn", renderStatusLine({ ...live, endTime: Date.now() }));
	};

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));

	pi.on("agent_start", async (_event, ctx) => {
		live = emptyStats(Date.now());
		live.thinkingLevel = pi.getThinkingLevel();
		// Seed the model from the active selection so the live line shows it
		// from the first tick; turn_end accumulation dedupes the same id.
		if (ctx.model) live.models.push(`${ctx.model.provider}/${ctx.model.id}`);
		stopTicker();
		if (!ctx.hasUI) return;
		pushLive(ctx);
		// Live duration ticker. Must self-defuse: a session can be disposed
		// without session_shutdown, and a throw inside a timer callback would
		// kill the whole pi process (see the 0006-titlebar-spinner incident).
		ticker = setInterval(() => {
			try {
				if (!live) {
					stopTicker();
					return;
				}
				pushLive(ctx);
			} catch {
				stopTicker();
			}
		}, LIVE_TICK_MS);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!live) return;
		accumulateAssistantMessage(live, event.message);
		pushLive(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTicker();
		live = null;
		// Freeze at the branch-derived truth (also correct after aborts).
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTicker();
		live = null;
	});

	pi.registerCommand("last-turn", {
		description: "Show token/cost stats for the last prompt cycle (in/out, cache write/read, hit ratio)",
		handler: async (_args, ctx: ExtensionContext) => {
			const stats = computeLastPromptStats(ctx.sessionManager.getBranch());
			if (!stats) {
				if (ctx.hasUI) ctx.ui.notify("No completed prompt on this branch yet", "info");
				return;
			}
			pi.sendMessage(
				{ customType: "last-turn", content: renderDetails(stats), display: true },
				{ triggerTurn: false },
			);
			// Commands run even mid-stream; while a prompt is live the ticker
			// owns the status line — don't clobber it with branch-derived stats.
			if (!live) updateStatus(ctx);
		},
	});
}
