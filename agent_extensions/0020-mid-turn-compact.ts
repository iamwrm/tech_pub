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
 * Run `/mid-turn-compact` for interactive settings or enable directly with
 * `/mid-turn-compact enable`. Default: disabled with a 100% window scale when
 * no preference is saved. Enablement is durable in Pi's global settings;
 * `/mid-turn-compact 150` and `/mid-turn-compact 30%` change the effective
 * context window used by this extension without mutating pi's model catalog.
 *
 * Soft threshold matches core pi after applying the extension-local scale:
 *   tokens > (contextWindow * percentage / 100) - reserveTokens
 *   (default reserve 16384)
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
 * 0017 is an optional backend enhancement; 0020 imports no sibling extension
 * and remains directly activatable against Pi's public compact API. 0021 is
 * orthogonal reasoning-replay policy and is not required by this extension.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	getAgentDir,
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";

/** Default reserve tokens; matches pi CompactionSettings.reserveTokens. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** Use the model-advertised context window unless the user explicitly scales it. */
export const DEFAULT_CONTEXT_WINDOW_PERCENT = 100;

/** Compact choices for the interactive settings row; direct arguments accept any positive finite percentage. */
export const CONTEXT_WINDOW_PERCENT_PRESETS = [30, 50, 75, 100, 125, 150, 200] as const;

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

/** Namespace used for extension-owned values in Pi's global settings.json. */
export const PI_SETTINGS_NAMESPACE = "renPublicPackage";

/** Settings key for the durable mid-turn compact preference. */
export const MID_TURN_COMPACT_SETTINGS_KEY = "midTurnCompact";

export type MidTurnCompactStatus = {
	enabled: boolean;
	inFlight: boolean;
	compactsThisRun: number;
	contextWindowPercent: number;
};

type ContinuationLease = symbol;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Resolve Pi's global settings file, honoring PI_CODING_AGENT_DIR. */
export function getMidTurnCompactSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readSettingsObject(settingsPath: string): JsonObject {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isJsonObject(parsed)) throw new Error("Pi settings must contain a JSON object");
		return parsed;
	} catch (error) {
		if (isFileNotFound(error)) return {};
		throw error;
	}
}

/** Read the persisted preference; a missing or malformed preference defaults off. */
export function readPersistedMidTurnCompactEnabled(settingsPath: string = getMidTurnCompactSettingsPath()): boolean {
	try {
		const settings = readSettingsObject(settingsPath);
		const namespace = settings[PI_SETTINGS_NAMESPACE];
		if (!isJsonObject(namespace)) return false;
		const feature = namespace[MID_TURN_COMPACT_SETTINGS_KEY];
		if (!isJsonObject(feature)) return false;
		return feature.enabled === true;
	} catch {
		return false;
	}
}

/**
 * Persist only the extension-owned preference while preserving all other Pi
 * settings. The temp-file replacement prevents a partially-written settings
 * file if the process is interrupted during the write.
 */
export function persistMidTurnCompactEnabled(
	enabled: boolean,
	settingsPath: string = getMidTurnCompactSettingsPath(),
): void {
	const settings = readSettingsObject(settingsPath);
	const currentNamespace = isJsonObject(settings[PI_SETTINGS_NAMESPACE]) ? settings[PI_SETTINGS_NAMESPACE] : {};
	const currentFeature = isJsonObject(currentNamespace[MID_TURN_COMPACT_SETTINGS_KEY])
		? currentNamespace[MID_TURN_COMPACT_SETTINGS_KEY]
		: {};
	settings[PI_SETTINGS_NAMESPACE] = {
		...currentNamespace,
		[MID_TURN_COMPACT_SETTINGS_KEY]: {
			...currentFeature,
			enabled,
		},
	};

	const directory = dirname(settingsPath);
	mkdirSync(directory, { recursive: true });
	const temporaryPath = join(directory, `.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`);
	let mode: number | undefined;
	if (existsSync(settingsPath)) mode = statSync(settingsPath).mode & 0o777;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
			encoding: "utf8",
			...(mode === undefined ? {} : { mode }),
		});
		renameSync(temporaryPath, settingsPath);
	} finally {
		try {
			unlinkSync(temporaryPath);
		} catch (error) {
			if (!isFileNotFound(error)) throw error;
		}
	}
}

/**
 * Footer chip text beside session stats. Enabled non-default window scales
 * replace "on" so the active override stays visible.
 * Exported for unit tests.
 */
export function renderFooterStatus(
	enabled: boolean,
	contextWindowPercent: number = DEFAULT_CONTEXT_WINDOW_PERCENT,
): string {
	if (!enabled) return FOOTER_STATUS_OFF;
	return contextWindowPercent === DEFAULT_CONTEXT_WINDOW_PERCENT
		? FOOTER_STATUS_ON
		: `midturn-compact: ${formatContextWindowPercent(contextWindowPercent)}`;
}

/** Parse a positive percentage with an optional trailing `%`. */
export function parseContextWindowPercent(input: string): number | null {
	const match = input.trim().match(/^(?:\d+(?:\.\d+)?|\.\d+)\s*%?$/);
	if (!match) return null;
	const value = Number.parseFloat(match[0]);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** Format a percentage without adding insignificant decimal zeroes. */
export function formatContextWindowPercent(percent: number): string {
	return `${String(percent)}%`;
}

/** Scale the model-advertised window for this extension's threshold only. */
export function getEffectiveContextWindow(
	contextWindow: number | null | undefined,
	contextWindowPercent: number = DEFAULT_CONTEXT_WINDOW_PERCENT,
): number | null {
	if (contextWindow === null || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return null;
	}
	if (!Number.isFinite(contextWindowPercent) || contextWindowPercent <= 0) return null;
	const effectiveContextWindow = (contextWindow * contextWindowPercent) / 100;
	return Number.isFinite(effectiveContextWindow) && effectiveContextWindow > 0 ? effectiveContextWindow : null;
}

export type ContextWindowMetrics = {
	effectiveContextWindow: number;
	softThreshold: number;
};

/** Resolve the scaled window and fixed-reserve threshold shown by the settings UI. */
export function getContextWindowMetrics(
	contextWindow: number | null | undefined,
	contextWindowPercent: number,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): ContextWindowMetrics | null {
	const effectiveContextWindow = getEffectiveContextWindow(contextWindow, contextWindowPercent);
	if (effectiveContextWindow === null) return null;
	return {
		effectiveContextWindow,
		softThreshold: effectiveContextWindow - reserveTokens,
	};
}

/** Compact token formatting for settings labels (for example 81.6k or 1.2m). */
export function formatCompactTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens)) return "?";
	const formatScaled = (value: number, suffix: string): string => {
		const rounded = Math.round(value * 10) / 10;
		return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
	};
	const absolute = Math.abs(tokens);
	if (absolute >= 1_000_000) return formatScaled(tokens / 1_000_000, "m");
	if (absolute >= 1_000) return formatScaled(tokens / 1_000, "k");
	return String(Math.round(tokens));
}

/** Value shown on the top-level settings row. */
export function formatContextWindowSettingValue(
	contextWindowPercent: number,
	contextWindow: number | null | undefined,
): string {
	const percent = formatContextWindowPercent(contextWindowPercent);
	const metrics = getContextWindowMetrics(contextWindow, contextWindowPercent);
	return metrics === null ? percent : `${percent} · ${formatCompactTokenCount(metrics.effectiveContextWindow)} effective`;
}

function formatContextWindowChoiceDescription(
	contextWindow: number | null | undefined,
	contextWindowPercent: number,
): string {
	const parts: string[] = [];
	const metrics = getContextWindowMetrics(contextWindow, contextWindowPercent);
	if (metrics === null) {
		parts.push("of model metadata");
	} else {
		parts.push(`${formatCompactTokenCount(metrics.effectiveContextWindow)} effective`);
		parts.push(
			metrics.softThreshold <= 0
				? "compact immediately (reserve exceeds window)"
				: `compact above ${formatCompactTokenCount(metrics.softThreshold)}`,
		);
	}
	if (contextWindowPercent === DEFAULT_CONTEXT_WINDOW_PERCENT) parts.push("model default");
	if (contextWindowPercent > 100) parts.push("⚠ provider may overflow first");
	return parts.join(" · ");
}

type ContextWindowPercentSubmenuOptions = {
	currentPercent: number;
	contextWindow: number | null | undefined;
	theme: Theme;
	onDone: (percent?: number) => void;
};

/** SelectList presets plus an Input-backed custom percentage screen. */
class ContextWindowPercentSubmenu extends Container {
	private activeInput: Component | undefined;
	private customInput: Input | undefined;
	private customStatus: Text | undefined;
	private mode: "picker" | "custom" = "picker";

	constructor(private readonly options: ContextWindowPercentSubmenuOptions) {
		super();
		this.showPicker();
	}

	handleInput(data: string): void {
		this.activeInput?.handleInput?.(data);
		if (this.mode === "custom") this.refreshCustomStatus();
	}

	private setContent(content: Component, input: Component): void {
		this.clear();
		this.addChild(content);
		this.activeInput = input;
	}

	private showPicker(): void {
		this.mode = "picker";
		this.customInput = undefined;
		this.customStatus = undefined;

		const content = new Container();
		content.addChild(new Text(this.options.theme.fg("accent", this.options.theme.bold("Context window")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(
			new Text(
				this.options.theme.fg(
					"muted",
					"Select an effective window scale. This changes only the mid-turn threshold; 100% uses model metadata.",
				),
				0,
				0,
			),
		);
		content.addChild(new Spacer(1));

		const percentages = [...new Set([...CONTEXT_WINDOW_PERCENT_PRESETS, this.options.currentPercent])].sort(
			(a, b) => a - b,
		);
		const items: SelectItem[] = percentages.map((percent) => ({
			value: String(percent),
			label: formatContextWindowPercent(percent),
			description: formatContextWindowChoiceDescription(this.options.contextWindow, percent),
		}));
		items.push({
			value: "custom",
			label: "Custom…",
			description: "Enter any positive percentage",
		});

		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 18,
		});
		selectList.setSelectedIndex(items.findIndex((item) => item.value === String(this.options.currentPercent)));
		selectList.onSelect = (item) => {
			if (item.value === "custom") {
				this.showCustomInput();
				return;
			}
			const percent = parseContextWindowPercent(item.value);
			if (percent !== null) this.options.onDone(percent);
		};
		selectList.onCancel = () => this.options.onDone();
		content.addChild(selectList);
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.options.theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
		this.setContent(content, selectList);
	}

	private showCustomInput(): void {
		this.mode = "custom";
		const content = new Container();
		content.addChild(
			new Text(this.options.theme.fg("accent", this.options.theme.bold("Custom context-window percentage")), 0, 0),
		);
		content.addChild(new Spacer(1));
		content.addChild(
			new Text(this.options.theme.fg("muted", 'Enter a positive percentage; the trailing "%" is optional.'), 0, 0),
		);
		content.addChild(new Spacer(1));

		const input = new Input();
		// Inserting through the public input path leaves the cursor at the end.
		input.handleInput(formatContextWindowPercent(this.options.currentPercent));
		input.onSubmit = (value) => {
			const percent = parseContextWindowPercent(value);
			if (percent !== null) this.options.onDone(percent);
		};
		input.onEscape = () => this.showPicker();
		content.addChild(input);
		content.addChild(new Spacer(1));

		this.customStatus = new Text("", 0, 0);
		content.addChild(this.customStatus);
		content.addChild(new Spacer(1));
		content.addChild(new Text(this.options.theme.fg("dim", "  Enter to apply · Esc to return to presets"), 0, 0));
		this.customInput = input;
		this.setContent(content, input);
		this.refreshCustomStatus();
	}

	private refreshCustomStatus(): void {
		if (!this.customInput || !this.customStatus) return;
		const percent = parseContextWindowPercent(this.customInput.getValue());
		if (percent === null) {
			this.customStatus.setText(this.options.theme.fg("warning", "Enter a positive number, optionally followed by %."));
			return;
		}

		const metrics = getContextWindowMetrics(this.options.contextWindow, percent);
		const lines =
			metrics === null
				? [`Effective window: ${formatContextWindowPercent(percent)} of active model metadata`]
				: [
						`Effective window: ${formatCompactTokenCount(metrics.effectiveContextWindow)}`,
						metrics.softThreshold <= 0
							? "Mid-turn threshold: immediate (reserve exceeds window)"
							: `Mid-turn threshold: ${formatCompactTokenCount(metrics.softThreshold)}`,
					];
		if (percent > 100) {
			lines.push(this.options.theme.fg("warning", "⚠ Above the advertised model window; the provider may overflow first."));
		}
		this.customStatus.setText(lines.join("\n"));
	}
}

/**
 * Soft-threshold check matching pi `shouldCompact`, with an optional
 * extension-local context-window scale. Exported for unit tests.
 */
export function isOverSoftThreshold(
	tokens: number | null | undefined,
	contextWindow: number | null | undefined,
	reserveTokens: number = DEFAULT_RESERVE_TOKENS,
	contextWindowPercent: number = DEFAULT_CONTEXT_WINDOW_PERCENT,
): boolean {
	if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return false;
	const effectiveContextWindow = getEffectiveContextWindow(contextWindow, contextWindowPercent);
	if (effectiveContextWindow === null) return false;
	return tokens > effectiveContextWindow - reserveTokens;
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
	contextWindowPercent?: number;
}): boolean {
	if (!options.enabled) return false;
	if (options.inFlight) return false;
	if (options.toolResultCount <= 0) return false;
	return isOverSoftThreshold(
		options.tokens,
		options.contextWindow,
		options.reserveTokens,
		options.contextWindowPercent,
	);
}

type CommandAction =
	| { kind: "settings" }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "status" }
	| { kind: "set-percent"; percent: number }
	| { kind: "help" };

function parseCommandArgs(args: string): CommandAction {
	const value = args.trim().toLowerCase();
	if (value === "") return { kind: "settings" };
	if (value === "enable" || value === "on" || value === "1" || value === "true") return { kind: "enable" };
	if (value === "disable" || value === "off" || value === "0" || value === "false") return { kind: "disable" };
	if (value === "status") return { kind: "status" };
	const percent = parseContextWindowPercent(value);
	return percent === null ? { kind: "help" } : { kind: "set-percent", percent };
}

export const STALE_EXTENSION_CONTEXT_ERROR_PREFIX =
	"This extension ctx is stale after session replacement or reload.";

export function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX);
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isExtensionContextActive(ctx: ExtensionContext): boolean {
	try {
		// Ownership is checked separately through the continuation lease. This
		// probe covers the remaining liveness race where Pi invalidates every
		// property on a replaced/reloaded extension context.
		void ctx.hasUI;
		return true;
	} catch (error) {
		if (isStaleExtensionContextError(error)) return false;
		throw error;
	}
}

function notifyIfActive(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	try {
		notify(ctx, message, level);
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

export default function midTurnCompact(pi: ExtensionAPI): void {
	let enabled = readPersistedMidTurnCompactEnabled();
	let inFlight = false;
	let compactsThisRun = 0;
	let contextWindowPercent = DEFAULT_CONTEXT_WINDOW_PERCENT;
	let boundaryContextWindowPercent: number | undefined;
	let continuationLease: ContinuationLease | undefined;

	const abandonActiveBoundary = (): void => {
		continuationLease = undefined;
		inFlight = false;
		boundaryContextWindowPercent = undefined;
	};

	const resetRunCounters = (): void => {
		abandonActiveBoundary();
		compactsThisRun = 0;
	};

	const status = (): MidTurnCompactStatus => ({
		enabled,
		inFlight,
		compactsThisRun,
		contextWindowPercent,
	});

	const formatStatus = (ctx: ExtensionContext | ExtensionCommandContext): string => {
		const s = status();
		const advertisedContextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
		const effectiveContextWindow = getEffectiveContextWindow(advertisedContextWindow, s.contextWindowPercent);
		const windowStatus =
			effectiveContextWindow === null || advertisedContextWindow === null || advertisedContextWindow === undefined
				? formatContextWindowPercent(s.contextWindowPercent)
				: `${formatContextWindowPercent(s.contextWindowPercent)} (${Math.round(effectiveContextWindow)} effective from ${Math.round(advertisedContextWindow)})`;
		return [
			`mid-turn-compact: ${s.enabled ? "enabled" : "disabled"}`,
			`context window: ${windowStatus}`,
			`in-flight: ${s.inFlight ? "yes" : "no"}`,
			`compacts this interaction: ${s.compactsThisRun}`,
		].join("; ");
	};

	const pushFooterStatus = (ctx: ExtensionContext | ExtensionCommandContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, renderFooterStatus(enabled, contextWindowPercent));
	};

	const clearFooterStatus = (ctx: ExtensionContext | ExtensionCommandContext): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
	};

	const setEnabled = (
		nextEnabled: boolean,
		ctx: ExtensionContext | ExtensionCommandContext,
		announce: boolean,
	): void => {
		enabled = nextEnabled;
		// Disabling blocks future admission but does not strand a task that this
		// extension already aborted. Its current boundary retains one final resume.
		pushFooterStatus(ctx);

		try {
			persistMidTurnCompactEnabled(enabled);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Mid-turn compact changed for this session, but Pi config could not be saved: ${message}`, "error");
		}

		if (!announce) return;
		notify(
			ctx,
			enabled
				? "Mid-turn compact enabled. Soft threshold fires at turn_end when tools are pending."
				: "Mid-turn compact disabled.",
			"info",
		);
	};

	const setContextWindowPercent = (
		percent: number,
		ctx: ExtensionContext | ExtensionCommandContext,
		announce: boolean,
	): void => {
		contextWindowPercent = percent;
		pushFooterStatus(ctx);
		if (!announce) return;
		let message = `Mid-turn compact context-window scale set to ${formatContextWindowPercent(percent)}.`;
		if (!enabled) message += " Mid-turn compact remains disabled.";
		if (percent > 100) message += " This does not change the provider limit and may overflow before the boundary.";
		notify(ctx, message, percent > 100 ? "warning" : "info");
	};

	const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			pushFooterStatus(ctx);
			notify(
				ctx,
				`${formatStatus(ctx)}. Interactive settings require TUI mode; use enable, disable, status, or a percentage argument.`,
				"info",
			);
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const advertisedContextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
			const items: SettingItem[] = [
				{
					id: "enabled",
					label: "Enabled",
					description: "Interrupt over-threshold tool loops, compact after settlement, and resume the task.",
					currentValue: enabled ? "on" : "off",
					values: ["off", "on"],
				},
				{
					id: "context-window-percent",
					label: "Context window",
					description:
						"Press Enter to choose a preset or type a custom percentage. Scaling is extension-local; values above 100% may hit the provider limit first.",
					currentValue: formatContextWindowSettingValue(contextWindowPercent, advertisedContextWindow),
					submenu: (_currentValue, submenuDone) =>
						new ContextWindowPercentSubmenu({
							currentPercent: contextWindowPercent,
							contextWindow: advertisedContextWindow,
							theme,
							onDone: (percent) => {
								if (percent === undefined) {
									submenuDone();
									return;
								}
								setContextWindowPercent(percent, ctx, false);
								submenuDone(formatContextWindowSettingValue(percent, advertisedContextWindow));
							},
						}),
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Mid-turn compact settings")), 1, 1));
			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 10),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "enabled") setEnabled(newValue === "on", ctx, false);
				},
				() => done(undefined),
			);
			container.addChild(settingsList);

			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	const resumeTask = (ctx: ExtensionContext, note: string, lease: ContinuationLease): void => {
		// Symbol identity is both an ownership check and a one-shot claim. An old
		// callback cannot act after a branch/task replacement, run twice, or clear
		// state belonging to a newer boundary.
		if (continuationLease !== lease) return;
		continuationLease = undefined;

		// ctx.compact() is fire-and-forget. Its callback may arrive after a
		// session replacement or reload, when both this ctx and the captured pi
		// API are stale. Abandon that old task rather than resuming the new one.
		if (!isExtensionContextActive(ctx)) return;
		try {
			pi.sendUserMessage(MID_TURN_CONTINUE_PROMPT);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) {
				const message = error instanceof Error ? error.message : String(error);
				notifyIfActive(ctx, `Mid-turn compact resume failed: ${message}`, "error");
			}
			return;
		}
		notifyIfActive(ctx, note, "info");
	};

	const startMidTurnBoundary = (ctx: ExtensionContext): void => {
		continuationLease = Symbol("mid-turn-compact-continuation");
		inFlight = true;
		boundaryContextWindowPercent = contextWindowPercent;
		compactsThisRun += 1;
		notify(ctx, `Mid-turn compact boundary starting (#${compactsThisRun})…`, "info");
		// Interrupt before the next model sample, but do not race pi's post-run
		// auto-compaction with a delayed manual compact. agent_settled runs only
		// after pi has completed its retry/compaction lifecycle.
		ctx.abort();
	};

	const compactAfterSettlement = (ctx: ExtensionContext): void => {
		const lease = continuationLease;
		// A branch/session/new-task boundary can revoke ownership before this
		// settlement. Never reconstruct or resume an operation without its lease.
		if (!lease) {
			inFlight = false;
			boundaryContextWindowPercent = undefined;
			return;
		}

		// Consume this settlement before starting the fire-and-forget fallback.
		// A compacted context reports tokens:null until its next assistant turn;
		// that is evidence that pi already owned this forced boundary. Use the
		// same scale that admitted the boundary even if settings changed meanwhile.
		const settledContextWindowPercent = boundaryContextWindowPercent ?? contextWindowPercent;
		inFlight = false;
		boundaryContextWindowPercent = undefined;
		const usage = ctx.getContextUsage();
		if (!isOverSoftThreshold(usage?.tokens, usage?.contextWindow, DEFAULT_RESERVE_TOKENS, settledContextWindowPercent)) {
			resumeTask(ctx, "Mid-turn compact done; resuming task.", lease);
			return;
		}

		// Pi did not compact (most commonly because the new tool results, rather
		// than the preceding assistant usage, crossed the threshold). Use its
		// public manual boundary now that the agent is fully settled. Wire shape
		// and call/result pairing under server compaction remain 0017's concern.
		ctx.compact({
			onComplete: () => {
				resumeTask(ctx, "Mid-turn compact done; resuming task.", lease);
			},
			onError: () => {
				// Pi already renders compaction_end failures. Resume without emitting a
				// second copy of the same error.
				resumeTask(ctx, "Mid-turn compact failed; resuming without compaction.", lease);
			},
		});
	};

	// Claim task transfer as soon as input is accepted, including a queued steer
	// or follow-up that has not reached before_agent_start yet. Preserve only this
	// extension's own synthetic continuation.
	pi.on("input", (event) => {
		if (event.source !== "extension" || event.text !== MID_TURN_CONTINUE_PROMPT) {
			abandonActiveBoundary();
			compactsThisRun = 0;
		}
	});

	// Keep an informational count across synthetic resumes. before_agent_start is
	// also a fallback ownership boundary for host/programmatic paths that bypass
	// the ordinary input event.
	pi.on("before_agent_start", (event) => {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (prompt !== MID_TURN_CONTINUE_PROMPT) {
			abandonActiveBoundary();
			compactsThisRun = 0;
		}
	});

	pi.on("session_start", (event, ctx) => {
		resetRunCounters();
		pushFooterStatus(ctx);
	});
	pi.on("session_tree", resetRunCounters);
	const preserveLeaseAcrossConfigurationChange = (): void => {
		// Model and thinking configuration may change while manual compaction is
		// pending. They do not transfer branch/task ownership, so the lease stays
		// valid and the continuation uses Pi's then-current configuration.
	};
	pi.on("model_select", preserveLeaseAcrossConfigurationChange);
	pi.on("thinking_level_select", preserveLeaseAcrossConfigurationChange);
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
				contextWindowPercent,
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
		description: "Configure mid-turn soft-threshold compaction (no args for settings; enable|disable|status|PERCENT)",
		handler: async (args, ctx) => {
			const action = parseCommandArgs(args);
			switch (action.kind) {
				case "settings":
					await openSettings(ctx);
					return;
				case "enable":
					setEnabled(true, ctx, true);
					return;
				case "disable":
					setEnabled(false, ctx, true);
					return;
				case "set-percent":
					setContextWindowPercent(action.percent, ctx, true);
					return;
				case "status":
					pushFooterStatus(ctx);
					notify(ctx, formatStatus(ctx), "info");
					return;
				default:
					notify(
						ctx,
						"Usage: /mid-turn-compact [enable|disable|status|PERCENT] (no args opens settings)",
						"warning",
					);
			}
		},
	});
}
