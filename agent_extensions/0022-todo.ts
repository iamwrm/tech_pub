/**
 * Standalone mirror of iamwrm/piagent-config
 * `packages/ren-public-package/0022-todo.ts` (the source of truth, where it ships
 * with unit tests). Sibling helpers are inlined so this file can be copied
 * alone into agent_extensions.
 * Try it without installing: `pi -e ./0022-todo.ts`
 *
 * Inlined: todo-hud.ts and todo-hud-fullscreen.ts.

 */

import {
	StringEnum,
} from "@earendil-works/pi-ai";
import {
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	TuiAltScreen,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	Type,
} from "typebox";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type TodoOperation = "init" | "start" | "done" | "drop" | "block" | "unblock" | "append" | "rm" | "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface TodoOperationParams {
	op: TodoOperation;
	list?: Array<{ phase: string; items: string[] }>;
	task?: string;
	phase?: string;
	items?: string[];
	reason?: string;
}

export interface TodoDetails {
	op: TodoOperation;
	phases: TodoPhase[];
	error?: string;
}

const TodoParams = Type.Object({
	op: StringEnum(["init", "start", "done", "drop", "block", "unblock", "append", "rm", "view"] as const),
	list: Type.Optional(
		Type.Array(
			Type.Object({
				phase: Type.String({ description: "Unique phase name" }),
				items: Type.Array(Type.String({ description: "Unique task content" }), { minItems: 1 }),
			}),
			{ minItems: 1, description: "Complete phased list for init" },
		),
	),
	task: Type.Optional(Type.String({ description: "Exact task content from the latest todo result" })),
	phase: Type.Optional(Type.String({ description: "Exact phase name" })),
	items: Type.Optional(Type.Array(Type.String({ description: "Tasks to append" }), { minItems: 1 })),
	reason: Type.Optional(Type.String({ description: "Why a task is blocked" })),
});

const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "abandoned", "blocked"]);

function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.map((task) =>
			task.blocker === undefined
				? { content: task.content, status: task.status }
				: { content: task.content, status: task.status, blocker: task.blocker },
		),
	}));
}

export function isTodoSnapshot(value: unknown): value is TodoPhase[] {
	if (!Array.isArray(value)) return false;
	return value.every((phase) => {
		if (!phase || typeof phase !== "object") return false;
		const candidate = phase as { name?: unknown; tasks?: unknown };
		if (typeof candidate.name !== "string" || !Array.isArray(candidate.tasks)) return false;
		return candidate.tasks.every((task) => {
			if (!task || typeof task !== "object") return false;
			const item = task as { content?: unknown; status?: unknown; blocker?: unknown };
			return (
				typeof item.content === "string" &&
				typeof item.status === "string" &&
				TODO_STATUSES.has(item.status as TodoStatus) &&
				(item.blocker === undefined || typeof item.blocker === "string")
			);
		});
	});
}
function findTask(phases: TodoPhase[], content: string): { phase: TodoPhase; task: TodoItem } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((candidate) => candidate.content === content);
		if (task) return { phase, task };
	}
	return undefined;
}

function normalizeProgress(phases: TodoPhase[]): void {
	const tasks = phases.flatMap((phase) => phase.tasks);
	const active = tasks.filter((task) => task.status === "in_progress");
	for (const task of active.slice(1)) task.status = "pending";
	if (active.length === 0) {
		const next = tasks.find((task) => task.status === "pending");
		if (next) next.status = "in_progress";
	}
}

function validateName(value: string, kind: "phase" | "task"): string | undefined {
	if (!value || value.trim() !== value || /[\r\n]/.test(value)) {
		return kind + " must be non-empty, trimmed, and single-line";
	}
	return undefined;
}

function initPhases(list: TodoOperationParams["list"]): TodoPhase[] | string {
	if (!list?.length) return "init requires a non-empty list";
	const phaseNames = new Set<string>();
	const taskNames = new Set<string>();
	for (const phase of list) {
		const phaseError = validateName(phase.phase, "phase");
		if (phaseError) return phaseError;
		if (phaseNames.has(phase.phase)) return "duplicate phase: " + phase.phase;
		if (phase.items.length === 0) return "phase has no tasks: " + phase.phase;
		phaseNames.add(phase.phase);
		for (const content of phase.items) {
			const taskError = validateName(content, "task");
			if (taskError) return taskError;
			if (taskNames.has(content)) return "duplicate task: " + content;
			taskNames.add(content);
		}
	}
	return list.map((phase) => ({
		name: phase.phase,
		tasks: phase.items.map((content) => ({ content, status: "pending" })),
	}));
}

function targetedTasks(
	phases: TodoPhase[],
	params: Pick<TodoOperationParams, "task" | "phase">,
): TodoItem[] | string {
	const hasTask = typeof params.task === "string" && params.task.length > 0;
	const hasPhase = typeof params.phase === "string" && params.phase.length > 0;
	if (hasTask === hasPhase) return "operation requires exactly one of task or phase";
	if (hasTask) {
		const hit = findTask(phases, params.task as string);
		return hit ? [hit.task] : "task not found: " + params.task;
	}
	const phase = phases.find((candidate) => candidate.name === params.phase);
	return phase ? phase.tasks : "phase not found: " + params.phase;
}

function appendItems(phases: TodoPhase[], phaseName: string | undefined, items: string[] | undefined): string | undefined {
	if (!phaseName) return "append requires phase";
	const phaseError = validateName(phaseName, "phase");
	if (phaseError) return phaseError;
	if (!items?.length) return "append requires non-empty items";
	const seen = new Set<string>();
	for (const content of items) {
		const taskError = validateName(content, "task");
		if (taskError) return taskError;
		if (seen.has(content) || findTask(phases, content)) return "duplicate task: " + content;
		seen.add(content);
	}
	let phase = phases.find((candidate) => candidate.name === phaseName);
	if (!phase) {
		phase = { name: phaseName, tasks: [] };
		phases.push(phase);
	}
	phase.tasks.push(...items.map((content) => ({ content, status: "pending" as const })));
	return undefined;
}

export function applyTodoOperation(
	current: readonly TodoPhase[],
	params: TodoOperationParams,
): { phases: TodoPhase[]; error?: string } {
	let phases = clonePhases(current);
	let error: string | undefined;

	switch (params.op) {
		case "view":
			return { phases };
		case "init": {
			const initialized = initPhases(params.list);
			if (typeof initialized === "string") error = initialized;
			else phases = initialized;
			break;
		}
		case "start": {
			if (!params.task) {
				error = "start requires task";
				break;
			}
			const hit = findTask(phases, params.task);
			if (!hit) {
				error = "task not found: " + params.task;
				break;
			}
			for (const task of phases.flatMap((phase) => phase.tasks)) {
				if (task.status === "in_progress") task.status = "pending";
			}
			hit.task.status = "in_progress";
			hit.task.blocker = undefined;
			break;
		}
		case "done":
		case "drop":
		case "block":
		case "unblock": {
			const targets = targetedTasks(phases, params);
			if (typeof targets === "string") {
				error = targets;
				break;
			}
			const reason = params.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of targets) {
				if (params.op === "done") {
					task.status = "completed";
					task.blocker = undefined;
				} else if (params.op === "drop") {
					task.status = "abandoned";
					task.blocker = undefined;
				} else if (params.op === "block") {
					if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") {
						task.status = "blocked";
						task.blocker = reason;
					}
				} else if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			break;
		}
		case "append":
			error = appendItems(phases, params.phase, params.items);
			break;
		case "rm": {
			if (params.task && params.phase) {
				error = "rm accepts task or phase, not both";
				break;
			}
			if (params.task) {
				const hit = findTask(phases, params.task);
				if (!hit) error = "task not found: " + params.task;
				else {
					hit.phase.tasks = hit.phase.tasks.filter((task) => task !== hit.task);
					phases = phases.filter((phase) => phase.tasks.length > 0);
				}
			} else if (params.phase) {
				const before = phases.length;
				phases = phases.filter((phase) => phase.name !== params.phase);
				if (phases.length === before) error = "phase not found: " + params.phase;
			} else {
				phases = [];
			}
			break;
		}
	}

	if (error) return { phases: clonePhases(current), error };
	normalizeProgress(phases);
	return { phases };
}

export function formatTodoPhases(phases: readonly TodoPhase[]): string {
	const tasks = phases.flatMap((phase) => phase.tasks);
	if (tasks.length === 0) return "Todo list is empty.";
	const closed = tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
	const open = tasks.filter((task) => task.status === "pending" || task.status === "in_progress").length;
	const blocked = tasks.filter((task) => task.status === "blocked").length;
	const marker: Record<TodoStatus, string> = {
		pending: "[ ]",
		in_progress: "[/]",
		completed: "[x]",
		abandoned: "[-]",
		blocked: "[!]",
	};
	const lines = ["Todo: " + closed + "/" + tasks.length + " closed, " + open + " open, " + blocked + " blocked."];
	for (const phase of phases) {
		lines.push(phase.name + ":");
		for (const task of phase.tasks) {
			const blocker = task.status === "blocked" && task.blocker ? " (blocked: " + task.blocker + ")" : "";
			lines.push("  " + marker[task.status] + " " + task.content + blocker);
		}
	}
	return lines.join("\n");
}

function snapshotFromContext(ctx: ExtensionContext): TodoPhase[] {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todo") continue;
		const details = message.details as Partial<TodoDetails> | undefined;
		if (details && isTodoSnapshot(details.phases)) return clonePhases(details.phases);
	}
	return [];
}

export default function todoExtension(pi: ExtensionAPI): void {
	let phases: TodoPhase[] = [];

	// --- Floating HUD (passive non-capturing overlay) ---------------------
	// Best-effort: every TUI touch is guarded so a stale session/UI can never
	// break the tool; state rides along in tool results either way.
	const viewState = createTodoHudViewState();
	const hud = {
		enabled: process.env.PI_TODO_HUD !== "0",
		opened: false,
		opening: false,
		collapsed: false,
		forceExpanded: false,
		ctx: undefined as ExtensionContext | undefined,
		component: undefined as TodoHudComponent | undefined,
		handle: undefined as { setHidden(hidden: boolean): void; hide(): void } | undefined,
		requestRender: undefined as (() => void) | undefined,
		term: undefined as { columns: number; rows: number } | undefined,
		layout: undefined as TodoHudLayout | undefined,
		maxRows: 0,
		onResize: undefined as (() => void) | undefined,
		generation: 0,
	};
	const pointer = new FullscreenTodoHudPointer({
		requestRender: () => hud.requestRender?.(),
		collapse: () => setCollapsed(true),
		expand: () => setCollapsed(false),
	});

	const desiredLayout = (termWidth: number): TodoHudLayout | null =>
		todoHudLayout(termWidth, phases, { collapsed: hud.collapsed, forceExpanded: hud.forceExpanded });

	const layoutKey = (layout: TodoHudLayout | null, maxRows: number): string =>
		layout
			? `${layout.mode}:${layout.width}:${layout.anchor}:${layout.margin.top}:${layout.margin.right}:${layout.margin.bottom}:${layout.margin.left}:${maxRows}`
			: `hidden:${maxRows}`;

	const detachResize = (): void => {
		if (!hud.onResize) return;
		try {
			process.stdout.removeListener("resize", hud.onResize);
		} catch {
			// best-effort
		}
		hud.onResize = undefined;
	};

	const resetHud = (): void => {
		detachResize();
		pointer.setComponent(undefined);
		hud.opened = false;
		hud.opening = false;
		hud.ctx = undefined;
		hud.component = undefined;
		hud.handle = undefined;
		hud.requestRender = undefined;
		hud.term = undefined;
		hud.layout = undefined;
		hud.maxRows = 0;
	};

	const closeHud = (): void => {
		// Close exclusively via handle.hide(): the ctx.ui.custom close path
		// (done()) pops the TOPMOST overlay, which may be another extension's
		// (e.g. the prompt-pin HUD). The custom() promise is intentionally
		// left unsettled; state is reset here instead.
		const handle = hud.handle;
		hud.generation += 1;
		resetHud();
		try {
			handle?.hide();
		} catch {
			// stale session — already reset above
		}
	};

	const openHud = (ctx: ExtensionContext): void => {
		const expected = desiredLayout(process.stdout.columns ?? 80);
		if (!expected) return;
		const generation = ++hud.generation;
		hud.opening = true;
		hud.ctx = ctx;
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (hud.generation === generation) resetHud();
		};
		try {
			void ctx.ui
				.custom<void>(
					(tui, theme, _keybindings, _done) => {
						hud.requestRender = () => {
							try {
								tui.requestRender();
							} catch {
								finish();
							}
						};
						hud.term = (tui as { terminal?: { columns: number; rows: number } }).terminal ?? undefined;
						const layout = desiredLayout(hud.term?.columns ?? process.stdout.columns ?? 80);
						if (!layout) throw new Error("todo HUD has no usable terminal layout");
						hud.layout = layout;
						hud.maxRows = todoHudRowLimit(hud.term?.rows ?? process.stdout.rows ?? 24);
						const component = new TodoHudComponent(theme, {
							mode: layout.mode,
							maxRows: hud.maxRows,
							viewState,
						});
						component.setPhases(phases);
						hud.component = component;
						pointer.install();
						pointer.setComponent(component);
						attachResize();
						hud.opened = true;
						hud.opening = false;
						return component;
					},
					{
						overlay: true,
							overlayOptions: () => ({
								nonCapturing: true,
								anchor: hud.layout?.anchor ?? "top-right",
								width: hud.layout?.width ?? 0,
								maxHeight: "70%",
								margin: hud.layout?.margin ?? 0,
								visible: (termWidth: number, termHeight: number) => {
									const next = desiredLayout(termWidth);
									return layoutKey(next, todoHudRowLimit(termHeight)) === layoutKey(hud.layout ?? null, hud.maxRows);
								},
							}),
						onHandle: (handle) => {
							hud.handle = {
								setHidden: (hidden: boolean) => {
									try {
										handle.setHidden(hidden);
									} catch {
										finish();
									}
								},
								hide: () => {
									try {
										handle.hide();
									} catch {
										// best-effort
									}
								},
							};
						},
					},
				)
				.then(finish, finish);
		} catch {
			finish();
		}
	};

	const reopenHud = (): void => {
		const ctx = hud.ctx;
		closeHud();
		if (ctx && hud.enabled && phases.some((phase) => phase.tasks.length > 0)) openHud(ctx);
	};

	function setCollapsed(collapsed: boolean): void {
		hud.collapsed = collapsed;
		hud.forceExpanded = !collapsed;
		if (hud.opened || hud.opening) reopenHud();
	}

	const attachResize = (): void => {
		detachResize();
		const handler = (): void => {
			try {
				if (!hud.opened || !hud.term) return;
				const next = desiredLayout(hud.term.columns);
				const maxRows = todoHudRowLimit(hud.term.rows);
				if (layoutKey(next, maxRows) !== layoutKey(hud.layout ?? null, hud.maxRows)) reopenHud();
			} catch {
				detachResize();
			}
		};
		hud.onResize = handler;
		try {
			process.stdout.on("resize", handler);
		} catch {
			hud.onResize = undefined;
		}
	};

	const refreshHud = (ctx: ExtensionContext | undefined): void => {
		try {
			if (!hud.enabled || !ctx) return;
			const empty = phases.length === 0 || phases.every((phase) => phase.tasks.length === 0);
			if (empty) {
				hud.handle?.setHidden(true);
				return;
			}
			if (hud.opened) {
				const next = desiredLayout(hud.term?.columns ?? process.stdout.columns ?? 80);
				const maxRows = todoHudRowLimit(hud.term?.rows ?? process.stdout.rows ?? 24);
				if (layoutKey(next, maxRows) !== layoutKey(hud.layout ?? null, hud.maxRows)) {
					reopenHud();
					return;
				}
				hud.component?.setPhases(phases);
				hud.handle?.setHidden(false);
				hud.requestRender?.();
				return;
			}
			if (!hud.opening && ctx.mode === "tui" && typeof ctx.ui?.custom === "function") openHud(ctx);
		} catch {
			// HUD is best-effort; tool results still carry the full state
		}
	};

	const restore = (ctx: ExtensionContext): void => {
		phases = snapshotFromContext(ctx);
	};
	pi.on("session_start", (_event, ctx) => {
		restore(ctx);
		refreshHud(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
		viewState.followActive = true;
		refreshHud(ctx);
	});
	pi.on("session_shutdown", () => {
		closeHud();
		pointer.dispose();
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Maintain a branch-persistent phased task list addressed by exact content. " +
			"Use init(list); start(task); done/drop/block/unblock(task or phase); append(phase, items); " +
			"rm(task or phase, or neither to clear); view(). The earliest pending task auto-starts.",
		promptSnippet: "Track multi-step work with a branch-persistent phased checklist",
		promptGuidelines: [
			"Use todo for work with three or more meaningful steps; initialize every requested item, then mark each task done immediately after completion.",
			"In todo calls, reuse task content and phase names exactly as shown by the latest todo result; use view instead of guessing.",
		],
		parameters: TodoParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTodoOperation(phases, params);
			if (!result.error && params.op !== "view") phases = clonePhases(result.phases);
			if (!result.error) refreshHud(ctx);
			const details: TodoDetails = { op: params.op, phases: clonePhases(result.phases) };
			if (result.error) details.error = result.error;
			return {
				content: [{ type: "text", text: result.error ? "Todo error: " + result.error : formatTodoPhases(result.phases) }],
				details,
				isError: result.error ? true : undefined,
			};
		},
	});

	pi.registerCommand("todo", {
		description: "Todo list and HUD controls: /todo [status] or /todo hud <action>",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "hud") {
				const action = parts[1] ?? "status";
				if (action === "on") hud.enabled = true;
				else if (action === "off") hud.enabled = false;
				else if (action === "toggle") hud.enabled = !hud.enabled;
				else if (action === "collapse") setCollapsed(true);
				else if (action === "expand") setCollapsed(false);
				else if (action === "active") {
					if (hud.component?.followActive()) hud.requestRender?.();
				}
				else if (action === "older" || action === "newer") {
					if (hud.component?.scrollRows(action === "older" ? -3 : 3)) hud.requestRender?.();
				}
				else if (action !== "status") {
					ctx.ui.notify(
						"Usage: /todo hud [on|off|toggle|status|collapse|expand|active|older|newer]",
						"info",
					);
					return;
				}
				if (action === "on" || action === "off" || action === "toggle") {
					if (hud.enabled) refreshHud(ctx);
					else closeHud(); // closeHud owns hiding via handle.hide()
				}
				const overlay = hud.enabled ? (hud.opened ? "overlay open" : "overlay closed") : "disabled";
				const view =
					hud.collapsed || hud.layout?.mode === "compact"
						? "collapsed"
						: viewState.followActive
							? "following active"
							: "scrolled";
				ctx.ui.notify(`Todo HUD ${hud.enabled ? "on" : "off"} · ${overlay} · ${view}`, "info");
				return;
			}
			if (!parts[0] || parts[0] === "status") {
				ctx.ui.notify(formatTodoPhases(phases), "info");
				return;
			}
			ctx.ui.notify(
				"Usage: /todo [status] | /todo hud [on|off|toggle|status|collapse|expand|active|older|newer]",
				"info",
			);
		},
	});
}

export type TodoHudColor = "accent" | "dim" | "text" | "warning";

export interface TodoHudTheme {
	fg(color: TodoHudColor, text: string): string;
}

export type TodoHudMode = "expanded" | "compact";
export type TodoHudHit = "collapse" | "expand" | "active";

export interface TodoHudViewState {
	followActive: boolean;
	scrollRow: number;
}

export interface TodoHudLayout {
	mode: TodoHudMode;
	width: number;
	anchor: "top-right";
	margin: { top: number; right: number; bottom: number; left: number };
}

/** Normal expanded width, including borders. */
export const TODO_HUD_WIDTH = 40;
/** Expanded panels open automatically at this terminal width. */
export const TODO_HUD_EXPANDED_TERM_WIDTH = 30;
/** Floor for the compact badge width; it widens for the bracketed title and large counts. */
export const TODO_HUD_COMPACT_WIDTH = 8;
/** Maximum expanded interior rows. */
export const TODO_HUD_MAX_ROWS = 16;

const MIN_COMPACT_WIDTH = 8;
const MIN_EXPANDED_WIDTH = 8;

const MARKER: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[/]",
	completed: "[x]",
	abandoned: "[-]",
	blocked: "[!]",
};

interface TodoHudRenderResult {
	lines: string[];
	hits: Array<{ type: TodoHudHit; x: number; y: number; width: number; height: number }>;
	/** The width this frame was rendered at; inter-render scroll math needs it. */
	width: number;
}

function isSettled(status: TodoStatus): boolean {
	return status === "completed" || status === "abandoned";
}

function phaseIsFullySettled(phase: TodoPhase): boolean {
	return phase.tasks.length > 0 && phase.tasks.every((task) => isSettled(task.status));
}

export function createTodoHudViewState(): TodoHudViewState {
	return { followActive: true, scrollRow: 0 };
}

export function todoHudProgress(phases: readonly TodoPhase[]): { closed: number; total: number; blocked: number } {
	const tasks = phases.flatMap((phase) => phase.tasks);
	return {
		closed: tasks.filter((task) => isSettled(task.status)).length,
		total: tasks.length,
		blocked: tasks.filter((task) => task.status === "blocked").length,
	};
}

export function compactTodoHudWidth(phases: readonly TodoPhase[]): number {
	const { closed, total } = todoHudProgress(phases);
	return Math.max(
		TODO_HUD_COMPACT_WIDTH,
		// The title row is `╭ [ToDo]╮`; keep the badge wide enough that the
		// bracketed title never overflows the border at the base width.
		visibleWidth("[ToDo]") + 3,
		visibleWidth(`${closed}/${total}`) + 2,
	);
}

/** Responsive overlay geometry. Manual collapse wins; narrow auto-collapse can be explicitly expanded. */
export function todoHudLayout(
	termWidth: number,
	phases: readonly TodoPhase[],
	options: { collapsed: boolean; forceExpanded: boolean },
): TodoHudLayout | null {
	const safeWidth = Math.max(0, Math.floor(termWidth));
	const compactWidth = compactTodoHudWidth(phases);
	const compact = options.collapsed || (safeWidth < TODO_HUD_EXPANDED_TERM_WIDTH && !options.forceExpanded);
	if (compact) {
		if (safeWidth < compactWidth || compactWidth < MIN_COMPACT_WIDTH) return null;
		const rightMargin = safeWidth >= compactWidth + 2 ? 2 : 0;
		return {
			mode: "compact",
			width: compactWidth,
			anchor: "top-right",
			margin: { top: 1, right: rightMargin, bottom: 0, left: 0 },
		};
	}
	if (safeWidth < MIN_EXPANDED_WIDTH) return null;
	if (safeWidth >= TODO_HUD_WIDTH + 2) {
		return {
			mode: "expanded",
			width: TODO_HUD_WIDTH,
			anchor: "top-right",
			margin: { top: 1, right: 2, bottom: 0, left: 0 },
		};
	}
	const margin = safeWidth >= 12 ? 1 : 0;
	return {
		mode: "expanded",
		width: safeWidth - margin * 2,
		anchor: "top-right",
		margin: { top: margin, right: margin, bottom: 0, left: 0 },
	};
}

/** Interior row budget sized to the overlay's 70%-of-terminal-height cap. */
export function todoHudRowLimit(termHeight: number): number {
	const available = Math.floor(Math.max(1, termHeight) * 0.7) - 2;
	return Math.max(4, Math.min(TODO_HUD_MAX_ROWS, available));
}

function centerPlain(text: string, width: number): { left: string; text: string; right: string } {
	const fitted = truncateToWidth(text, width, "");
	const remaining = Math.max(0, width - visibleWidth(fitted));
	const left = Math.floor(remaining / 2);
	return { left: " ".repeat(left), text: fitted, right: " ".repeat(remaining - left) };
}

function renderCompactTodoHud(
	phases: readonly TodoPhase[],
	theme: TodoHudTheme,
	width: number,
	hovered: boolean,
): TodoHudRenderResult {
	const { closed, total, blocked } = todoHudProgress(phases);
	if (total === 0 || width < MIN_COMPACT_WIDTH) return { lines: [], hits: [], width };
	const innerWidth = width - 2;
	const border = hovered ? "accent" : "dim";
	const progress = centerPlain(`${closed}/${total}`, innerWidth);
	const borderText = (text: string) => theme.fg(border, text);
	const progressColor: TodoHudColor = blocked > 0 ? "warning" : "dim";
	// The bracketed title needs `╭ [ToDo]╮` = 9 columns; at the width-8 floor
	// (only reachable by direct renders — the layout path widens the badge via
	// compactTodoHudWidth), fall back to the plain label so the frame never
	// overflows its declared width.
	const title = width >= visibleWidth("[ToDo]") + 3 ? "[ToDo]" : "Todo";
	const titleGap = Math.max(0, innerWidth - visibleWidth(title) - 1);
	const lines = [
		borderText("╭ ") + theme.fg("accent", title) + borderText(`${" ".repeat(titleGap)}╮`),
		borderText("│") + progress.left + theme.fg(progressColor, progress.text) + progress.right + borderText("│"),
		borderText(`╰${"─".repeat(innerWidth)}╯`),
	];
	return {
		lines,
		hits: [{ type: "expand", x: 0, y: 0, width, height: lines.length }],
		width,
	};
}

function wrappedTodoRows(
	phases: readonly TodoPhase[],
	theme: TodoHudTheme,
	innerWidth: number,
): { rows: string[]; activeRow?: number } {
	const rows: string[] = [];
	let activeRow: number | undefined;
	let fallbackRow: number | undefined;
	for (const phase of phases) {
		if (phase.tasks.length === 0) continue;
		if (phaseIsFullySettled(phase)) {
			const done = phase.tasks.filter((task) => task.status === "completed").length;
			rows.push(...wrapTextWithAnsi(theme.fg("dim", `✓ ${phase.name} (${done}/${phase.tasks.length})`), innerWidth));
			continue;
		}
		rows.push(...wrapTextWithAnsi(theme.fg("dim", phase.name), innerWidth));
		for (const task of phase.tasks) {
			const markerColor: TodoHudColor =
				task.status === "in_progress" ? "accent" : task.status === "blocked" ? "warning" : "dim";
			const contentColor: TodoHudColor =
				task.status === "blocked" ? "warning" : isSettled(task.status) ? "dim" : "text";
			const blocker = task.status === "blocked" && task.blocker ? theme.fg("dim", ` (${task.blocker})`) : "";
			const prefix = theme.fg(markerColor, MARKER[task.status]) + " ";
			const prefixWidth = visibleWidth(prefix);
			const wrapped = wrapTextWithAnsi(
				theme.fg(contentColor, task.content) + blocker,
				Math.max(1, innerWidth - prefixWidth),
			);
			const firstRow = rows.length;
			const continuation = " ".repeat(prefixWidth);
			rows.push(...wrapped.map((line, index) => (index === 0 ? prefix : continuation) + line));
			if (task.status === "in_progress") activeRow = firstRow;
			else if (!isSettled(task.status) && fallbackRow === undefined) fallbackRow = firstRow;
		}
	}
	activeRow ??= fallbackRow;
	return { rows, ...(activeRow === undefined ? {} : { activeRow }) };
}

/**
 * Content-row budget for a scrolled viewport after reserving indicator rows.
 *
 * The iteration starts from the full row limit and only ever decreases (the
 * indicator count can only grow as the budget shrinks, because the window end
 * is non-increasing), so it converges to the maximal fixed point — the most
 * content rows, with indicator rows only when the window genuinely cannot fit
 * more. The loop runs until the value stabilizes instead of trusting a fixed
 * pass count.
 */
function viewportContentBudget(rowLimit: number, footerRows: number, rowsLength: number, start: number): number {
	let contentBudget = Math.max(1, rowLimit - footerRows);
	for (;;) {
		const end = Math.min(rowsLength, start + contentBudget);
		const indicators = (start > 0 ? 1 : 0) + (end < rowsLength ? 1 : 0);
		const next = Math.max(1, rowLimit - footerRows - indicators);
		if (next === contentBudget) return contentBudget;
		contentBudget = next;
	}
}

/** The return-to-active control row shown whenever follow is disengaged. */
function activeControlRow(theme: TodoHudTheme): string {
	return theme.fg("accent", "[↓ Active]") + theme.fg("dim", " return to current task");
}

interface TodoHudWindow {
	/** First visible wrapped row. */
	start: number;
	/** Number of content rows the window shows (borders/indicators/control excluded). */
	contentRows: number;
	/** The whole list fits; no indicator rows are shown. */
	fits: boolean;
}

/**
 * Single source of truth for the viewport window, shared by the renderer and
 * the wheel handler so the two cannot drift.
 *
 * `rowLimit` must already be normalized (`Math.max(4, Math.floor(...))`) —
 * both call sites normalize at entry, and the follow anchors use the same
 * normalized value.
 *
 * Fits mode (rowsLength <= rowLimit): following shows every row; a disengaged
 * view reserves one body row for the [↓ Active] control (rowLimit - 1 content
 * rows), so the frame never exceeds the overlay height cap on short
 * terminals. When the list exactly fills the budget, the last row is
 * deliberately left out: the window keeps the top/older rows manual scrolling
 * reached for, and re-engaging follow via [↓ Active] restores it. (Pinned by
 * the exact-fit unit test.)
 *
 * Scrolled mode: the budget fixpoint converges from the maximal fill (most
 * content rows; indicator rows only when the window genuinely cannot fit
 * more), so the clamped window is a pure function of the stored scrollRow —
 * same-state frames stay byte-identical (asserted by the same-state render
 * stability unit test). Following does not clamp the start; a disengaged
 * start clamps to the viewport's max.
 */
function computeWindow(
	rowsLength: number,
	rowLimit: number,
	followActive: boolean,
	startInput: number,
): TodoHudWindow {
	if (rowsLength <= rowLimit) {
		return {
			start: 0,
			contentRows: followActive ? rowsLength : Math.min(rowsLength, rowLimit - 1),
			fits: true,
		};
	}
	const footerRows = followActive ? 0 : 1;
	const budget = viewportContentBudget(rowLimit, footerRows, rowsLength, startInput);
	const start = followActive ? startInput : Math.min(startInput, Math.max(0, rowsLength - budget));
	return { start, contentRows: Math.min(rowsLength - start, budget), fits: false };
}

function viewport(
	rows: readonly string[],
	activeRow: number | undefined,
	state: TodoHudViewState,
	rowLimit: number,
	theme: TodoHudTheme,
): { lines: string[]; activeControlRow?: number } {
	const limit = Math.max(4, Math.floor(rowLimit));
	const startInput = state.followActive
		? (activeRow ?? Math.max(0, rows.length - limit))
		: Math.max(0, Math.min(state.scrollRow, rows.length - 1));
	const window = computeWindow(rows.length, limit, state.followActive, startInput);
	const end = window.start + window.contentRows;
	const lines: string[] = [];
	if (!window.fits && window.start > 0) lines.push(theme.fg("dim", `↑ ${window.start} older`));
	lines.push(...rows.slice(window.start, end));
	if (!window.fits && end < rows.length) lines.push(theme.fg("dim", `↓ ${rows.length - end} newer`));
	let controlRowIndex: number | undefined;
	if (!state.followActive) {
		controlRowIndex = lines.length;
		lines.push(activeControlRow(theme));
	}
	state.scrollRow = window.start;
	return { lines, ...(controlRowIndex === undefined ? {} : { activeControlRow: controlRowIndex }) };
}

function framedLine(line: string, theme: TodoHudTheme, width: number): string {
	const innerWidth = width - 4;
	const fitted = truncateToWidth(line, innerWidth, "…");
	const gap = innerWidth - visibleWidth(fitted);
	return `│ ${fitted}${gap > 0 ? " ".repeat(gap) : ""} │`;
}

function renderExpandedTodoHud(
	phases: readonly TodoPhase[],
	theme: TodoHudTheme,
	width: number,
	rowLimit: number,
	state: TodoHudViewState,
	hovered: TodoHudHit | undefined,
	wrappedInput?: { rows: string[]; activeRow?: number },
): TodoHudRenderResult {
	const { closed, total, blocked } = todoHudProgress(phases);
	if (total === 0 || width < MIN_EXPANDED_WIDTH) return { lines: [], hits: [], width };
	const innerWidth = width - 4;
	if (innerWidth <= 0) return { lines: [], hits: [], width };

	const collapseLabel = width >= 25 ? "[Collapse]" : "[-]";
	const titleCandidates = [
		`[ToDo] ${closed}/${total}${blocked > 0 ? ` · ${blocked} blocked` : ""}`,
		`[ToDo] ${closed}/${total}`,
		"[ToDo]",
		"",
	];
	const fixedHeaderWidth = 1 + 2 + 1 + visibleWidth(collapseLabel) + 1;
	const plainTitle = titleCandidates.find((candidate) => fixedHeaderWidth + visibleWidth(candidate) <= width) ?? "";
	const title = theme.fg("accent", plainTitle);
	const collapse = theme.fg(hovered === "collapse" ? "accent" : "dim", collapseLabel);
	const prefix = plainTitle ? `┌─ ${title} ` : "┌";
	const suffix = `${collapse}┐`;
	const fill = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
	const top = truncateToWidth(`${prefix}${"─".repeat(fill)}${suffix}`, width, "");
	const collapseX = Math.max(1, width - 1 - visibleWidth(collapseLabel));

	const wrapped = wrappedInput ?? wrappedTodoRows(phases, theme, innerWidth);
	const selected = viewport(wrapped.rows, wrapped.activeRow, state, rowLimit, theme);
	const body = selected.lines.map((line) => framedLine(line, theme, width));
	const bottom = `└${"─".repeat(Math.max(0, width - 2))}┘`;
	const hits: TodoHudRenderResult["hits"] = [
		{ type: "collapse", x: collapseX, y: 0, width: visibleWidth(collapseLabel), height: 1 },
	];
	if (selected.activeControlRow !== undefined) {
		hits.push({ type: "active", x: 2, y: 1 + selected.activeControlRow, width: visibleWidth("[↓ Active]"), height: 1 });
	}
	return {
		lines: [top, ...body, bottom],
		hits,
		width,
	};
}

/** Render a todo HUD frame. Stateful callers should pass a shared view state. */
export function renderTodoHud(
	phases: readonly TodoPhase[],
	theme: TodoHudTheme,
	width: number,
	maxRows: number = TODO_HUD_MAX_ROWS,
	options: { mode?: TodoHudMode; viewState?: TodoHudViewState; hovered?: TodoHudHit } = {},
): string[] {
	const mode = options.mode ?? "expanded";
	const state = options.viewState ?? createTodoHudViewState();
	return mode === "compact"
		? renderCompactTodoHud(phases, theme, width, options.hovered === "expand").lines
		: renderExpandedTodoHud(phases, theme, width, maxRows, state, options.hovered).lines;
}

export class TodoHudComponent implements Component {
	private current: readonly TodoPhase[] = [];
	private mode: TodoHudMode;
	/**
	 * The component's own view state. Components created without an explicit
	 * viewState now own persistent state (scroll/follow survive across
	 * renders) instead of silently no-op'ing; pass a shared viewState to
	 * coordinate several components or to reset externally.
	 */
	private readonly state: TodoHudViewState;
	private hovered: TodoHudHit | undefined;
	private last: TodoHudRenderResult = { lines: [], hits: [], width: 0 };
	/** Wrapped rows for the current phases, cached per (phases, width) pair. */
	private wrappedCache:
		| { phases: readonly TodoPhase[]; innerWidth: number; rows: string[]; activeRow?: number }
		| undefined;

	constructor(
		private readonly theme: TodoHudTheme,
		private readonly options: { maxRows?: number; mode?: TodoHudMode; viewState?: TodoHudViewState } = {},
	) {
		this.mode = options.mode ?? "expanded";
		this.state = options.viewState ?? createTodoHudViewState();
	}

	setPhases(phases: readonly TodoPhase[]): void {
		this.current = phases;
	}

	private wrappedRows(innerWidth: number): { rows: string[]; activeRow?: number } {
		const cached = this.wrappedCache;
		if (cached && cached.phases === this.current && cached.innerWidth === innerWidth) {
			return cached;
		}
		const wrapped = wrappedTodoRows(this.current, this.theme, innerWidth);
		this.wrappedCache = {
			phases: this.current,
			innerWidth,
			rows: wrapped.rows,
			activeRow: wrapped.activeRow,
		};
		return this.wrappedCache;
	}

	setMode(mode: TodoHudMode): void {
		this.mode = mode;
		this.hovered = undefined;
	}

	getMode(): TodoHudMode {
		return this.mode;
	}

	setHovered(hit: TodoHudHit | undefined): boolean {
		if (this.hovered === hit) return false;
		this.hovered = hit;
		return true;
	}

	getHovered(): TodoHudHit | undefined {
		return this.hovered;
	}

	isEmpty(): boolean {
		return this.current.length === 0 || this.current.every((phase) => phase.tasks.length === 0);
	}

	hitTest(x: number, y: number): TodoHudHit | undefined {
		return this.last.hits.find(
			(hit) => x >= hit.x && x < hit.x + hit.width && y >= hit.y && y < hit.y + hit.height,
		)?.type;
	}

	scrollRows(delta: number): boolean {
		const state = this.state;
		if (this.mode !== "expanded" || delta === 0) return false;
		const innerWidth = this.last.width - 4;
		if (innerWidth <= 0) return false;
		const rowLimit = Math.max(4, Math.floor(this.options.maxRows ?? TODO_HUD_MAX_ROWS));
		// Recompute from current phases, not the last rendered frame: the list may
		// have changed since, and right after [↓ Active] the previous startRow is
		// the stale scrolled position. The wrap is cached per (phases, width), so
		// unthrottled wheel packets do not re-wrap the list each time.
		const wrapped = this.wrappedRows(innerWidth);
		if (wrapped.rows.length === 0) return false;
		const disengage = state.followActive;
		const base = disengage
			? (wrapped.activeRow ?? Math.max(0, wrapped.rows.length - rowLimit))
			: state.scrollRow;
		// The wheel always disengages follow, so evaluate the window as a
		// disengaged view at the candidate: fits clamps to 0, and the scrolled
		// clamp uses the budget at the candidate itself, keeping the wheel
		// position and the rendered window consistent at the bottom edge (the
		// bottom indicator disappears exactly when the window reaches the list
		// end, freeing one more content row).
		const next = computeWindow(wrapped.rows.length, rowLimit, false, Math.max(0, base + Math.trunc(delta))).start;
		const changed = disengage || next !== state.scrollRow;
		state.followActive = false;
		state.scrollRow = next;
		return changed;
	}

	followActive(): boolean {
		const state = this.state;
		if (state.followActive) return false;
		state.followActive = true;
		return true;
	}

	render(width: number): string[] {
		const expanded = this.mode === "expanded";
		const wrapped = expanded && width - 4 > 0 && !this.isEmpty() ? this.wrappedRows(width - 4) : undefined;
		this.last = expanded
			? renderExpandedTodoHud(
				this.current,
				this.theme,
				width,
				this.options.maxRows ?? TODO_HUD_MAX_ROWS,
				this.state,
				this.hovered,
				wrapped,
			)
			: renderCompactTodoHud(this.current, this.theme, width, this.hovered === "expand");
		return this.last.lines;
	}

	invalidate(): void {
		// Stateless styling: render recomputes from phases, viewport, and hover.
	}
}

export const SUPPORTED_TODO_HUD_PI_VERSION = "0.84.2";
const PATCH_KEY = Symbol.for("ren-public-package.todo-hud-fullscreen.patch.v1");
const RENDER_PATCH_KEY = Symbol.for("ren-public-package.todo-hud-fullscreen.renderPatch.v1");

/** The styled-segment separator pi wraps overlay text with (compositeTuiLine). */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

interface RuntimeOverlayOptions {
	width?: number | string;
	minWidth?: number;
	maxHeight?: number | string;
	anchor?: string;
	offsetX?: number;
	offsetY?: number;
	row?: number | string;
	col?: number | string;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	visible?: (termWidth: number, termHeight: number) => boolean;
	nonCapturing?: boolean;
}

interface RuntimeOverlayEntry {
	component: Component;
	options?: RuntimeOverlayOptions;
	hidden: boolean;
}

interface RuntimeTui extends TUI {
	overlayStack?: RuntimeOverlayEntry[];
	resolveOverlayLayout?: (
		options: RuntimeOverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	) => { width: number; row: number; col: number; maxHeight?: number };
}

interface RuntimePrototype {
	handleViewportInput?: (this: RuntimeTui, data: string) => { consume?: boolean } | undefined;
	doRender?: (this: RuntimeTui) => void;
}

interface MouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface OverlayGeometry {
	target: Rect;
	occluders: Rect[];
}

interface TodoPointerController {
	wantsRuntime(): boolean;
	handle(tui: RuntimeTui, data: string): boolean;
	runtimeCrashed(): void;
}

interface PatchState {
	patched: boolean;
	dispatching: boolean;
	controllers: Set<TodoPointerController>;
	prototype?: RuntimePrototype;
	original?: NonNullable<RuntimePrototype["handleViewportInput"]>;
	wrapper?: NonNullable<RuntimePrototype["handleViewportInput"]>;
}

function globalPatchState(): PatchState {
	const target = globalThis as unknown as Record<symbol, PatchState | undefined>;
	return (target[PATCH_KEY] ??= { patched: false, dispatching: false, controllers: new Set() });
}

function activeController(state: PatchState): TodoPointerController | undefined {
	const controllers = [...state.controllers];
	for (let index = controllers.length - 1; index >= 0; index--) {
		const controller = controllers[index];
		if (controller?.wantsRuntime()) return controller;
	}
	return undefined;
}

function safelyCrash(controller: TodoPointerController | undefined): void {
	try {
		controller?.runtimeCrashed();
	} catch {
		// The original Pi input path remains authoritative after any failure.
	}
}

function installRuntimePatch(controller: TodoPointerController): boolean {
	if (process.env.PI_TODO_HUD_FULLSCREEN_PATCH === "0" || VERSION !== SUPPORTED_TODO_HUD_PI_VERSION) return false;
	const state = globalPatchState();
	state.controllers.add(controller);
	if (state.patched) return true;
	const prototype = TuiAltScreen.prototype as unknown as RuntimePrototype;
	const original = prototype.handleViewportInput;
	if (typeof original !== "function") {
		state.controllers.delete(controller);
		return false;
	}
	const wrapper: NonNullable<RuntimePrototype["handleViewportInput"]> = function patchedTodoHudViewportInput(
		this: RuntimeTui,
		data: string,
	) {
		// Multiple independently loaded copies can remain in a wrapper chain after
		// another extension restores an outer patch. Handle each packet once.
		if (state.dispatching) return original.call(this, data);
		state.dispatching = true;
		try {
			const current = activeController(state);
			if (current) {
				try {
					if (current.handle(this, data)) return { consume: true };
				} catch {
					safelyCrash(current);
				}
			}
			return original.call(this, data);
		} finally {
			state.dispatching = false;
		}
	};
	state.prototype = prototype;
	state.original = original;
	state.wrapper = wrapper;
	prototype.handleViewportInput = wrapper;
	state.patched = true;
	return true;
}

function uninstallRuntimePatch(controller: TodoPointerController): void {
	const state = globalPatchState();
	state.controllers.delete(controller);
	if (!state.patched || state.controllers.size > 0 || !state.prototype) return;
	// Restore only if our wrapper is still outermost. If another extension wraps
	// it, the dormant wrapper must remain as that extension's captured delegate.
	if (state.prototype.handleViewportInput === state.wrapper && state.original) {
		state.prototype.handleViewportInput = state.original;
	}
	state.patched = false;
	state.prototype = undefined;
	state.original = undefined;
	state.wrapper = undefined;
	state.dispatching = false;
}

interface TodoRenderController {
	wantsRender(): boolean;
	reduceFrame(tui: RuntimeTui, frame: string): string | undefined;
	runtimeCrashed(): void;
}

interface RenderPatchState {
	patched: boolean;
	dispatching: boolean;
	controllers: Set<TodoRenderController>;
	prototype?: RuntimePrototype;
	original?: (this: RuntimeTui) => void;
	wrapper?: (this: RuntimeTui) => void;
}

function globalRenderPatchState(): RenderPatchState {
	const target = globalThis as unknown as Record<symbol, RenderPatchState | undefined>;
	return (target[RENDER_PATCH_KEY] ??= { patched: false, dispatching: false, controllers: new Set() });
}

function activeRenderController(state: RenderPatchState): TodoRenderController | undefined {
	const controllers = [...state.controllers];
	for (let index = controllers.length - 1; index >= 0; index--) {
		const controller = controllers[index];
		if (controller?.wantsRender()) return controller;
	}
	return undefined;
}

/**
 * Install the frame-reduction seam: run the original doRender with the
 * terminal write captured, then emit either the reduced frame or the original
 * bytes. Fail-closed: any parse anomaly, geometry problem, or thrown error
 * passes the captured frame through byte-for-byte, and the terminal write is
 * always restored.
 */
function installRenderPatch(controller: TodoRenderController): boolean {
	if (process.env.PI_TODO_HUD_RENDER_PATCH === "0" || VERSION !== SUPPORTED_TODO_HUD_PI_VERSION) return false;
	const state = globalRenderPatchState();
	state.controllers.add(controller);
	if (state.patched) return true;
	const prototype = TuiAltScreen.prototype as unknown as RuntimePrototype;
	const original = prototype.doRender;
	if (typeof original !== "function") {
		state.controllers.delete(controller);
		return false;
	}
	const wrapper = function patchedTodoHudRender(this: RuntimeTui): void {
		if (state.dispatching) {
			original.call(this);
			return;
		}
		state.dispatching = true;
		try {
			const current = activeRenderController(state);
			if (!current) {
				original.call(this);
				return;
			}
			const terminal = this.terminal;
			const originalWrite = terminal.write.bind(terminal);
			let captured = "";
			let threw = false;
			terminal.write = (data: string) => {
				captured += data;
			};
			try {
				original.call(this);
			} catch (error) {
				threw = true;
				throw error;
			} finally {
				terminal.write = originalWrite;
			}
			if (threw) return; // doRender never wrote: nothing on screen to repair
			try {
				const reduced = current.reduceFrame(this, captured);
				originalWrite(reduced ?? captured);
			} catch {
				originalWrite(captured);
			}
		} finally {
			state.dispatching = false;
		}
	};
	state.prototype = prototype;
	state.original = original;
	state.wrapper = wrapper;
	prototype.doRender = wrapper;
	state.patched = true;
	return true;
}

function uninstallRenderPatch(controller: TodoRenderController): void {
	const state = globalRenderPatchState();
	state.controllers.delete(controller);
	if (!state.patched || state.controllers.size > 0 || !state.prototype) return;
	// Restore only if our wrapper is still outermost (see uninstallRuntimePatch).
	if (state.prototype.doRender === state.wrapper && state.original) {
		state.prototype.doRender = state.original;
	}
	state.patched = false;
	state.prototype = undefined;
	state.original = undefined;
	state.wrapper = undefined;
	state.dispatching = false;
}

/**
 * Parse an alt-screen frame into its row writes. Strict structural gates:
 * the frame must start with the synchronized-output begin and end with its
 * end marker, and every row command must be well formed. Anything else (or
 * hostile content that fabricates row headers) yields undefined and the
 * caller passes the frame through untouched.
 */
function parseFrameRows(
	frame: string,
): { header: string; rows: Array<{ row: number; content: string }>; tail: string } | undefined {
	if (!frame.startsWith("\x1b[?2026h") || !frame.endsWith("\x1b[?2026l")) return undefined;
	// The frame tail is cursor positioning + show/hide + the synchronized-output
	// end marker. Split it off first so the last row's content is not merged
	// with it (String.split leaves the final content and tail in one part).
	const tailMatch =
		/\x1b\[\d+;\d+H\x1b\[\?25[lh]\x1b\[\?2026l$/.exec(frame) ?? /\x1b\[\?25[lh]\x1b\[\?2026l$/.exec(frame);
	if (!tailMatch) return undefined;
	const tail = tailMatch[0];
	const body = frame.slice(0, tailMatch.index);
	const parts = body.split(/(\x1b\[\d+;1H\x1b\[2K)/);
	if (parts.length < 3) return { header: body, rows: [], tail };
	const rows: Array<{ row: number; content: string }> = [];
	for (let index = 1; index < parts.length; index += 2) {
		const match = /\x1b\[(\d+);1H/.exec(parts[index]!);
		if (!match) return undefined;
		rows.push({ row: Number(match[1]) - 1, content: parts[index + 1] ?? "" });
	}
	return { header: parts[0]!, rows, tail };
}

export function parseTodoHudMouse(data: string): MouseEvent | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	return {
		button: Number.parseInt(match[1]!, 10),
		x: Number.parseInt(match[2]!, 10) - 1,
		y: Number.parseInt(match[3]!, 10) - 1,
		release: match[4] === "m",
	};
}

function contains(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function componentGeometry(tui: RuntimeTui, component: TodoHudComponent): OverlayGeometry | undefined {
	const entries = tui.overlayStack;
	const resolve = tui.resolveOverlayLayout;
	if (!Array.isArray(entries) || typeof resolve !== "function") return undefined;
	const termWidth = Math.max(1, tui.terminal.columns);
	const termHeight = Math.max(1, tui.terminal.rows);
	let target: Rect | undefined;
	const occluders: Rect[] = [];
	let targetSeen = false;
	for (const entry of entries) {
		if (entry.hidden) continue;
		const options = entry.options;
		if (options?.visible && !options.visible(termWidth, termHeight)) continue;
		if (options?.nonCapturing !== true) return undefined;
		const initial = resolve.call(tui, options, 0, termWidth, termHeight);
		let lines = entry.component.render(initial.width);
		if (initial.maxHeight !== undefined && lines.length > initial.maxHeight) lines = lines.slice(0, initial.maxHeight);
		if (lines.length === 0) continue;
		const final = resolve.call(tui, options, lines.length, termWidth, termHeight);
		const rect = { x: final.col, y: final.row, width: final.width, height: lines.length };
		if (entry.component === component) {
			target = rect;
			targetSeen = true;
		} else if (targetSeen) {
			occluders.push(rect);
		}
	}
	return target ? { target, occluders } : undefined;
}

export interface TodoHudPointerHost {
	requestRender(): void;
	collapse(): void;
	expand(): void;
}

export class FullscreenTodoHudPointer implements TodoPointerController, TodoRenderController {
	private installed = false;
	private renderInstalled = false;
	private disposed = false;
	private failed = false;
	private component: TodoHudComponent | undefined;
	private pressActive = false;
	/** Overlay segments of the last frame's HUD rows, keyed by screen row. */
	private readonly rowCache = new Map<number, string>();
	private cachedRect: Rect | undefined;

	constructor(private readonly host: TodoHudPointerHost) {}

	install(): boolean {
		if (this.disposed || this.failed) return false;
		if (this.installed && this.renderInstalled) return true;
		this.installed = this.installed || installRuntimePatch(this);
		this.renderInstalled = this.renderInstalled || installRenderPatch(this);
		return this.installed && this.renderInstalled;
	}

	setComponent(component: TodoHudComponent | undefined): void {
		if (this.component !== component) {
			this.component?.setHovered(undefined);
			this.component = component;
			this.pressActive = false;
		}
	}

	wantsRuntime(): boolean {
		return this.installed && !this.disposed && !this.failed && this.component !== undefined;
	}

	wantsRender(): boolean {
		return this.renderInstalled && !this.disposed && !this.failed && this.component !== undefined;
	}

	/**
	 * Reduce a captured alt-screen frame: for rows in the todo HUD's span whose
	 * overlay segment is byte-identical to the previous frame's, re-emit only
	 * the base segments with a column jump over the overlay — no `ESC[2K`
	 * erase, no redundant HUD pixels. Returns undefined to pass the frame
	 * through untouched.
	 */
	reduceFrame(tui: RuntimeTui, frame: string): string | undefined {
		const component = this.component;
		if (!component || frame.includes("\x1b[2J")) {
			// Full-screen clears repaint everything; cached overlays are stale.
			this.rowCache.clear();
			this.cachedRect = undefined;
			return undefined;
		}
		const geometry = componentGeometry(tui, component);
		if (!geometry) {
			// HUD not painted this frame (hidden/absent/resized): the terminal
			// rows hold base content, so every cached overlay is stale.
			this.rowCache.clear();
			this.cachedRect = undefined;
			return undefined;
		}
		const target = geometry.target;
		if (
			!this.cachedRect ||
			this.cachedRect.x !== target.x ||
			this.cachedRect.y !== target.y ||
			this.cachedRect.width !== target.width ||
			this.cachedRect.height !== target.height
		) {
			this.rowCache.clear();
			this.cachedRect = target;
		}
		const parsed = parseFrameRows(frame);
		if (!parsed) return undefined;
		const out = [parsed.header];
		let anyReduced = false;
		for (const entry of parsed.rows) {
			if (entry.row >= target.y && entry.row < target.y + target.height) {
				const result = this.reduceRow(entry, target);
				if (result.kind === "reduced") {
					out.push(result.write);
					anyReduced = true;
					continue;
				}
				if (result.kind === "cached") this.rowCache.set(entry.row, result.overlay);
				else this.rowCache.delete(entry.row);
			}
			out.push(`\x1b[${entry.row + 1};1H\x1b[2K${entry.content}`);
		}
		out.push(parsed.tail);
		return anyReduced ? out.join("") : undefined;
	}

	/**
	 * Reduce one HUD-span row. The composited content is
	 * `before + SEGMENT_RESET + overlay + SEGMENT_RESET + after + SEGMENT_RESET`
	 * with the overlay exactly at the HUD rect's columns. If the overlay
	 * matches the previous frame, emit only the base segments and jump over the
	 * overlay columns. A changed overlay is returned for the caller to cache;
	 * any structural mismatch is "invalid" (the caller drops the cache entry).
	 */
	private reduceRow(
		entry: { row: number; content: string },
		target: Rect,
	): { kind: "reduced"; write: string } | { kind: "cached"; overlay: string } | { kind: "invalid" } {
		const parts = entry.content.split(SEGMENT_RESET);
		if (parts.length !== 4 || parts[3] !== "") return { kind: "invalid" };
		const before = parts[0]!;
		const overlay = parts[1]!;
		const after = parts[2]!;
		if (visibleWidth(before) !== target.x) return { kind: "invalid" };
		if (visibleWidth(overlay) !== target.width) return { kind: "invalid" };
		const cached = this.rowCache.get(entry.row);
		if (cached === overlay) {
			const jumpCol = target.x + target.width + 1;
			return {
				kind: "reduced",
				write: `\x1b[${entry.row + 1};1H${before}${SEGMENT_RESET}\x1b[${jumpCol}G${SEGMENT_RESET}${after}${SEGMENT_RESET}`,
			};
		}
		return { kind: "cached", overlay };
	}

	handle(tui: RuntimeTui, data: string): boolean {
		const event = parseTodoHudMouse(data);
		const component = this.component;
		if (!event || !component) return false;
		const geometry = componentGeometry(tui, component);
		if (!geometry) {
			if (component.setHovered(undefined)) this.host.requestRender();
			return false;
		}
		const inside = contains(geometry.target, event.x, event.y);
		const occluded = geometry.occluders.some((rect) => contains(rect, event.x, event.y));
		const ownsPoint = inside && !occluded;
		const localX = event.x - geometry.target.x;
		const localY = event.y - geometry.target.y;
		const wheel = (event.button & 64) !== 0;
		const motion = (event.button & 32) !== 0;
		const baseButton = event.button & 3;

		if (wheel) {
			if (!ownsPoint || component.getMode() !== "expanded") return false;
			const delta = (event.button & 1) === 0 ? -3 : 3;
			component.scrollRows(delta);
			this.host.requestRender();
			return true;
		}
		if (motion) {
			if (baseButton !== 3) return false;
			const hit = ownsPoint ? component.hitTest(localX, localY) : undefined;
			if (component.setHovered(hit)) this.host.requestRender();
			return ownsPoint;
		}

		const ownRelease = event.release && baseButton === 0 && this.pressActive;
		if (event.release && baseButton === 0) this.pressActive = false;
		if (!ownsPoint) {
			if (!event.release && baseButton === 0) this.pressActive = false;
			if (component.setHovered(undefined)) this.host.requestRender();
			return ownRelease;
		}
		if (!event.release && baseButton === 0) {
			const hit: TodoHudHit | undefined = component.hitTest(localX, localY);
			if (hit === "collapse") this.host.collapse();
			else if (hit === "expand") this.host.expand();
			else if (hit === "active" && component.followActive()) this.host.requestRender();
			// Collapse/expand replaces the component and clears its local press
			// state. Arm after the callback so the matching release is still ours.
			this.pressActive = true;
			return true;
		}
		return ownRelease;
	}

	runtimeCrashed(): void {
		this.failed = true;
		this.setComponent(undefined);
		if (this.installed) uninstallRuntimePatch(this);
		if (this.renderInstalled) uninstallRenderPatch(this);
		this.installed = false;
		this.renderInstalled = false;
		this.rowCache.clear();
		this.cachedRect = undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.setComponent(undefined);
		if (this.installed) uninstallRuntimePatch(this);
		if (this.renderInstalled) uninstallRenderPatch(this);
		this.installed = false;
		this.renderInstalled = false;
		this.rowCache.clear();
		this.cachedRect = undefined;
	}
}
