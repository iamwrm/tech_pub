/**
 * Token usage status for the most recently completed user prompt.
 *
 * Example footer layout:
 *   openai-codex/gpt-5.4 ↑73k R145k H67% W26k ↓398 $0.224
 *
 * Primary live update source is `agent_end`, because it fires once per user
 * prompt and already contains the assistant messages produced for that prompt.
 *
 * We also reconstruct the latest completed prompt from session history on
 * `session_start`, `session_switch`, `session_tree`, and `session_fork`.
 * This is needed because the footer status itself is not persisted: after a
 * reload, resume, branch navigation, or fork there may be no fresh `agent_end`
 * event to replay, but the user still expects the status line to reflect the
 * latest completed prompt on the current branch.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

const STATUS_KEY = "token-usage-last-turn";

type BranchEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: {
		total?: number;
	};
};

interface LastTurnUsageSummary {
	provider: string;
	modelId: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalCost: number;
	promptTokens: number;
	cacheHitPercent: number | null;
	usingOAuth: boolean;
	assistantMessageCount: number;
}

function isAssistantMessage(message: { role?: unknown }): message is AssistantMessage {
	return message.role === "assistant";
}

function isMessageEntry(entry: BranchEntry): entry is Extract<BranchEntry, { type: "message" }> {
	return entry.type === "message";
}

function formatTokens(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const abs = Math.abs(value);

	if (abs < 1_000) return `${Math.round(value)}`;
	if (abs < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (abs < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (abs < 10_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (abs < 1_000_000_000) return `${Math.round(value / 1_000_000)}m`;
	return `${(value / 1_000_000_000).toFixed(1)}b`;
}

function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0.000";
	if (value < 1) return value.toFixed(3);
	if (value < 10) return value.toFixed(2);
	if (value < 100) return value.toFixed(1);
	return Math.round(value).toString();
}

function computeCacheHitPercent(input: number, cacheRead: number): number | null {
	const promptTokens = input + cacheRead;
	if (promptTokens <= 0) return null;
	return (cacheRead / promptTokens) * 100;
}

function hasMeaningfulUsage(usage: UsageLike | undefined): boolean {
	if (!usage) return false;
	return (
		(usage.input ?? 0) > 0 ||
		(usage.output ?? 0) > 0 ||
		(usage.cacheRead ?? 0) > 0 ||
		(usage.cacheWrite ?? 0) > 0 ||
		(usage.cost?.total ?? 0) > 0
	);
}

function resolveUsingOAuth(ctx: ExtensionContext, provider: string, modelId: string): boolean {
	const model = ctx.modelRegistry.find(provider, modelId);
	return model ? ctx.modelRegistry.isUsingOAuth(model) : false;
}

function summarizeAssistantMessages(
	messages: AssistantMessage[],
	ctx: ExtensionContext,
): LastTurnUsageSummary | undefined {
	if (messages.length === 0) return undefined;
	if (!messages.some((message) => hasMeaningfulUsage(message.usage))) return undefined;

	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalCost = 0;

	for (const message of messages) {
		input += message.usage.input ?? 0;
		output += message.usage.output ?? 0;
		cacheRead += message.usage.cacheRead ?? 0;
		cacheWrite += message.usage.cacheWrite ?? 0;
		totalCost += message.usage.cost?.total ?? 0;
	}

	const last = messages[messages.length - 1];
	const promptTokens = input + cacheRead;
	const cacheHitPercent = computeCacheHitPercent(input, cacheRead);

	return {
		provider: last.provider,
		modelId: last.model,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalCost,
		promptTokens,
		cacheHitPercent,
		usingOAuth: resolveUsingOAuth(ctx, last.provider, last.model),
		assistantMessageCount: messages.length,
	};
}

function findLastTurnSummaryFromBranch(ctx: ExtensionContext): LastTurnUsageSummary | undefined {
	const messages = ctx.sessionManager
		.getBranch()
		.filter(isMessageEntry)
		.map((entry) => entry.message);

	for (let endIndex = messages.length - 1; endIndex >= 0; ) {
		let userIndex = -1;
		for (let i = endIndex; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				userIndex = i;
				break;
			}
		}

		if (userIndex === -1) return undefined;

		const assistants = messages.slice(userIndex + 1, endIndex + 1).filter(isAssistantMessage);
		const summary = summarizeAssistantMessages(assistants, ctx);
		if (summary) return summary;

		endIndex = userIndex - 1;
	}

	return undefined;
}

function sanitizeSingleLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function renderStatus(summary: LastTurnUsageSummary, ctx: ExtensionContext): string {
	const theme = ctx.ui.theme;
	const parts: string[] = [];

	parts.push(theme.fg("dim", "last"));
	parts.push(theme.fg("muted", `${summary.provider}/${summary.modelId}`));
	parts.push(`${theme.fg("dim", "↑")}${theme.fg("muted", formatTokens(summary.input))}`);
	parts.push(`${theme.fg("dim", "R")}${theme.fg("accent", formatTokens(summary.cacheRead))}`);

	if (summary.cacheHitPercent !== null) {
		const percentColor = summary.cacheHitPercent >= 70 ? "success" : summary.cacheHitPercent >= 30 ? "warning" : "dim";
		parts.push(`${theme.fg("dim", "H")}${theme.fg(percentColor, `${Math.round(summary.cacheHitPercent)}%`)}`);
	}

	if (summary.cacheWrite > 0) {
		parts.push(`${theme.fg("dim", "W")}${theme.fg("muted", formatTokens(summary.cacheWrite))}`);
	}

	parts.push(`${theme.fg("dim", "↓")}${theme.fg("muted", formatTokens(summary.output))}`);

	parts.push(`${theme.fg("dim", "$")}${theme.fg(summary.totalCost > 0 ? "muted" : "dim", formatCost(summary.totalCost))}`);

	if (summary.usingOAuth) {
		parts.push(theme.fg("dim", "(sub)"));
	}

	return sanitizeSingleLine(parts.join(" "));
}

function clearStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function setSummaryStatus(summary: LastTurnUsageSummary | undefined, ctx: ExtensionContext): void {
	if (!summary) {
		clearStatus(ctx);
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, renderStatus(summary, ctx));
}

function updateStatusFromBranch(ctx: ExtensionContext): void {
	setSummaryStatus(findLastTurnSummaryFromBranch(ctx), ctx);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		const summary = summarizeAssistantMessages(event.messages.filter(isAssistantMessage), ctx);
		if (summary) {
			setSummaryStatus(summary, ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatusFromBranch(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		updateStatusFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		updateStatusFromBranch(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		updateStatusFromBranch(ctx);
	});
}
