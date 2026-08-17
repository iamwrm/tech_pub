/**
 * Standalone mirror of iamwrm/piagent-config
 * `packages/ren-public-package/0023-quiz.ts` (the source of truth, where it ships
 * with unit tests). Sibling helpers are inlined so this file can be copied
 * alone into agent_extensions.
 * Try it without installing: `pi -e ./0023-quiz.ts`
 *
 * Inlined: quiz-ui.ts.

 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type EditorTheme,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	Type,
} from "typebox";

export const MAX_QUIZ_QUESTIONS = 4;
export const MAX_QUIZ_OPTIONS = 6;
export const MAX_QUIZ_NOTE_CHARS = 4000;
export const QUIZ_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";

export interface QuizOption {
	id: string;
	label: string;
	description?: string;
}

export interface QuizQuestion {
	id: string;
	question: string;
	options: QuizOption[];
}

export interface QuizParams {
	title?: string;
	questions: QuizQuestion[];
}

export interface QuizAnswer {
	questionId: string;
	optionId: string;
	optionLabel: string;
	note?: string;
}

export type QuizStatus = "submitted" | "cancelled" | "unavailable" | "issued";

export interface QuizProgress {
	answers?: readonly QuizAnswer[];
	notes?: Record<string, string>;
	reviewNote?: string;
	questionIndex?: number;
}

export interface QuizSnapshot {
	answers: QuizAnswer[];
	notes: Record<string, string>;
	reviewNote?: string;
	questionIndex: number;
}

export interface QuizDetails {
	status: QuizStatus;
	title?: string;
	questions: QuizQuestion[];
	answers: QuizAnswer[];
	reviewNote?: string;
	notes?: Record<string, string>;
	questionIndex?: number;
}

export interface QuizTheme {
	fg(color: "accent" | "dim" | "error" | "muted" | "success" | "text" | "warning", text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
}

const ID_PATTERN = new RegExp(QUIZ_ID_PATTERN);

/** Remove terminal control sequences from model-provided UI text. */
export function scrubQuizText(input: string): string {
	return input
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\][\s\S]*$/g, "")
		.replace(/\x1b(?:P|X|\^|_)[\s\S]*?\x1b\\/g, "")
		.replace(/\x1b(?:P|X|\^|_)[\s\S]*$/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]?/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
		.replace(/\r\n?/g, "\n");
}

function normalizedText(value: string, label: string, singleLine: boolean): string {
	const clean = scrubQuizText(value);
	const normalized = singleLine ? clean.replace(/\s+/g, " ").trim() : clean.trim();
	if (!normalized) throw new Error(`${label} must be non-empty`);
	return normalized;
}

function validateId(id: string, label: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new Error(`${label} must match ${ID_PATTERN.source}`);
	}
	return id;
}

/** Runtime semantic validation complements the TypeBox shape constraints. */
export function normalizeQuizParams(input: QuizParams): QuizParams {
	if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > MAX_QUIZ_QUESTIONS) {
		throw new Error(`quiz requires 1-${MAX_QUIZ_QUESTIONS} questions`);
	}
	const questionIds = new Set<string>();
	const questions = input.questions.map((question, questionIndex) => {
		const id = validateId(question.id, `questions[${questionIndex}].id`);
		if (questionIds.has(id)) throw new Error(`duplicate question id: ${id}`);
		questionIds.add(id);
		if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > MAX_QUIZ_OPTIONS) {
			throw new Error(`question ${id} requires 2-${MAX_QUIZ_OPTIONS} options`);
		}
		const optionIds = new Set<string>();
		const optionLabels = new Set<string>();
		const options = question.options.map((option, optionIndex) => {
			const optionId = validateId(option.id, `question ${id} options[${optionIndex}].id`);
			if (optionIds.has(optionId)) throw new Error(`duplicate option id in ${id}: ${optionId}`);
			optionIds.add(optionId);
			const label = normalizedText(option.label, `option ${id}/${optionId} label`, true);
			if (optionLabels.has(label)) throw new Error(`duplicate option label in ${id}: ${label}`);
			optionLabels.add(label);
			const description = option.description?.trim()
				? normalizedText(option.description, `option ${id}/${optionId} description`, false)
				: undefined;
			return description === undefined ? { id: optionId, label } : { id: optionId, label, description };
		});
		return {
			id,
			question: normalizedText(question.question, `question ${id}`, false),
			options,
		};
	});
	const title = input.title?.trim() ? normalizedText(input.title, "quiz title", true) : undefined;
	return title === undefined ? { questions } : { title, questions };
}

function toQuizProgress(
	answersOrProgress: readonly QuizAnswer[] | QuizProgress,
	reviewNote?: string,
): QuizProgress {
	if (Array.isArray(answersOrProgress)) return { answers: answersOrProgress as readonly QuizAnswer[], reviewNote };
	const progress = answersOrProgress as QuizProgress;
	return reviewNote === undefined ? progress : { ...progress, reviewNote };
}

export const ISSUED_QUIZ_TEXT =
	'Quiz issued. Stop and wait for the user to submit answers or ask something else. Do not call quiz again until a later message starts with "Quiz responses:" or the user skips this round.';

export function buildQuizDetails(
	status: QuizStatus,
	quiz: QuizParams,
	answersOrProgress: readonly QuizAnswer[] | QuizProgress = [],
	reviewNote?: string,
): QuizDetails {
	const progress = toQuizProgress(answersOrProgress, reviewNote);
	const details: QuizDetails = {
		status,
		questions: quiz.questions.map((question) => ({
			...question,
			options: question.options.map((option) => ({ ...option })),
		})),
		answers: (progress.answers ?? []).map((answer) => ({ ...answer })),
	};
	if (quiz.title !== undefined) details.title = quiz.title;
	if (progress.reviewNote !== undefined && progress.reviewNote.length > 0) details.reviewNote = progress.reviewNote;
	if (progress.notes !== undefined) details.notes = { ...progress.notes };
	if (progress.questionIndex !== undefined) details.questionIndex = progress.questionIndex;
	return details;
}

export function formatQuizResult(details: QuizDetails): string {
	if (details.status === "cancelled") return "User cancelled the quiz.";
	if (details.status === "issued") return ISSUED_QUIZ_TEXT;
	if (details.status === "unavailable") {
		return "Interactive quiz UI is unavailable in this mode. Ask the questions concisely in normal chat instead.";
	}
	const lines = ["Quiz responses:"];
	for (const answer of details.answers) {
		lines.push(`- ${answer.questionId}: ${answer.optionId} — ${answer.optionLabel}`);
		if (answer.note !== undefined) lines.push(`  note: ${JSON.stringify(answer.note)}`);
	}
	if (details.reviewNote !== undefined) lines.push(`review note: ${JSON.stringify(details.reviewNote)}`);
	return lines.join("\n");
}

function editorTheme(theme: QuizTheme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

/** Focus-aware modal used by the quiz tool and deterministic TUI tests. */
export class QuizComponent implements Component, Focusable {
	private readonly quiz: QuizParams;
	private readonly tui: TUI;
	private readonly theme: QuizTheme;
	private readonly finish: (status: "submitted" | "cancelled", snapshot: QuizSnapshot) => void;
	private readonly editor: Editor;
	private readonly cursors: number[];
	private readonly answers = new Map<string, QuizAnswer>();
	private readonly notes = new Map<string, string>();
	private reviewNote: string | undefined;
	private questionIndex = 0;
	private noteMode = false;
	private noteError: string | undefined;
	private cache: { width: number; lines: string[] } | undefined;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: QuizTheme,
		quiz: QuizParams,
		finish: (status: "submitted" | "cancelled", snapshot: QuizSnapshot) => void,
		progress: QuizProgress = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.quiz = quiz;
		this.finish = finish;
		this.cursors = quiz.questions.map(() => 0);
		this.editor = new Editor(tui, editorTheme(theme), { paddingX: 0 });
		this.editor.onChange = () => {
			this.noteError = undefined;
			this.changed();
		};
		this.editor.onSubmit = (value) => this.saveNote(value);
		this.applyProgress(progress);
	}

	private applyProgress(progress: QuizProgress): void {
		for (const [id, note] of Object.entries(progress.notes ?? {})) {
			this.notes.set(id, note);
		}
		for (const answer of progress.answers ?? []) {
			this.answers.set(answer.questionId, { ...answer });
			const questionIndex = this.quiz.questions.findIndex((question) => question.id === answer.questionId);
			if (questionIndex < 0) continue;
			const optionIndex = this.quiz.questions[questionIndex]?.options.findIndex((option) => option.id === answer.optionId) ?? -1;
			if (optionIndex >= 0) this.cursors[questionIndex] = optionIndex;
		}
		if (progress.reviewNote !== undefined && progress.reviewNote.length > 0) this.reviewNote = progress.reviewNote;
		if (progress.questionIndex !== undefined) {
			this.questionIndex = Math.max(0, Math.min(this.quiz.questions.length, progress.questionIndex));
		}
	}

	private snapshot(): QuizSnapshot {
		const notes = Object.fromEntries(this.notes);
		const snapshot: QuizSnapshot = {
			answers: this.orderedAnswers(),
			notes,
			questionIndex: this.questionIndex,
		};
		if (this.reviewNote !== undefined) snapshot.reviewNote = this.reviewNote;
		return snapshot;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.noteMode;
	}

	private get onReview(): boolean {
		return this.questionIndex === this.quiz.questions.length;
	}

	private get currentQuestion(): QuizQuestion | undefined {
		return this.quiz.questions[this.questionIndex];
	}

	private changed(): void {
		this.cache = undefined;
		this.tui.requestRender();
	}

	private orderedAnswers(): QuizAnswer[] {
		return this.quiz.questions.flatMap((question) => {
			const answer = this.answers.get(question.id);
			return answer ? [{ ...answer }] : [];
		});
	}

	private selectAndAdvance(): void {
		const question = this.currentQuestion;
		if (!question) return;
		const option = question.options[this.cursors[this.questionIndex] ?? 0];
		if (!option) return;
		const note = this.notes.get(question.id);
		const answer: QuizAnswer = {
			questionId: question.id,
			optionId: option.id,
			optionLabel: option.label,
		};
		if (note !== undefined) answer.note = note;
		this.answers.set(question.id, answer);
		this.questionIndex = Math.min(this.quiz.questions.length, this.questionIndex + 1);
		this.changed();
	}

	private moveQuestion(delta: number): void {
		this.questionIndex = Math.max(0, Math.min(this.quiz.questions.length, this.questionIndex + delta));
		this.changed();
	}

	private enterNoteMode(): void {
		if (!this.onReview && !this.currentQuestion) return;
		this.noteMode = true;
		this.noteError = undefined;
		this.editor.setText(this.onReview ? (this.reviewNote ?? "") : (this.notes.get(this.currentQuestion?.id ?? "") ?? ""));
		this.editor.focused = this._focused;
		this.changed();
	}

	private leaveNoteMode(): void {
		this.noteMode = false;
		this.noteError = undefined;
		this.editor.focused = false;
		this.changed();
	}

	private saveNote(value: string): void {
		const expanded = this.editor.getExpandedText ? this.editor.getExpandedText() : value;
		if (expanded.length > MAX_QUIZ_NOTE_CHARS) {
			this.noteError = `Note is ${expanded.length} characters; maximum is ${MAX_QUIZ_NOTE_CHARS}.`;
			this.changed();
			return;
		}
		if (this.onReview) {
			this.reviewNote = expanded.length === 0 ? undefined : expanded;
			this.leaveNoteMode();
			return;
		}
		const question = this.currentQuestion;
		if (!question) return;
		if (expanded.length === 0) this.notes.delete(question.id);
		else this.notes.set(question.id, expanded);
		const answer = this.answers.get(question.id);
		if (answer) {
			if (expanded.length === 0) delete answer.note;
			else answer.note = expanded;
		}
		this.leaveNoteMode();
	}

	handleInput(data: string): void {
		if (this.noteMode) {
			if (matchesKey(data, Key.escape)) {
				this.leaveNoteMode();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab)) {
				this.saveNote(this.editor.getText());
				return;
			}
			this.editor.handleInput(data);
			this.changed();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.finish("cancelled", this.snapshot());
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.moveQuestion(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.moveQuestion(1);
			return;
		}
		if (this.onReview) {
			if (matchesKey(data, Key.tab)) {
				this.enterNoteMode();
				return;
			}
			if (matchesKey(data, Key.enter) && this.answers.size === this.quiz.questions.length) {
				this.finish("submitted", this.snapshot());
			}
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.enterNoteMode();
			return;
		}
		const question = this.currentQuestion;
		if (!question) return;
		if (matchesKey(data, Key.up)) {
			this.cursors[this.questionIndex] = Math.max(0, (this.cursors[this.questionIndex] ?? 0) - 1);
			this.changed();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursors[this.questionIndex] = Math.min(
				question.options.length - 1,
				(this.cursors[this.questionIndex] ?? 0) + 1,
			);
			this.changed();
			return;
		}
		if (/^[1-6]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < question.options.length) {
				this.cursors[this.questionIndex] = index;
				this.changed();
			}
			return;
		}
		if (matchesKey(data, Key.enter)) this.selectAndAdvance();
	}

	private renderNoteSection(lines: string[], savedNote: string | undefined, width: number, kind: "question" | "review"): void {
		const prompt =
			kind === "review"
				? `Optional review note (${MAX_QUIZ_NOTE_CHARS} character maximum):`
				: `Optional note (${MAX_QUIZ_NOTE_CHARS} character maximum):`;
		const savedPrefix = kind === "review" ? "✓ Review note saved: " : "✓ Note saved: ";
		if (this.noteMode) {
			lines.push("");
			this.addWrapped(lines, this.theme.fg("muted", prompt), width, " ");
			for (const editorLine of this.editor.render(Math.max(1, width - 2))) {
				lines.push(truncateToWidth(` ${editorLine}`, width, ""));
			}
			if (this.noteError) this.addWrapped(lines, this.theme.fg("error", this.noteError), width, " ");
			return;
		}
		if (savedNote !== undefined) {
			lines.push("");
			this.addWrapped(lines, this.theme.fg("success", `${savedPrefix}${scrubQuizText(savedNote)}`), width, " ");
		}
	}

	private addWrapped(lines: string[], text: string, width: number, prefix = ""): void {
		const prefixWidth = visibleWidth(prefix);
		if (prefixWidth >= width) {
			lines.push(truncateToWidth(prefix + text, width, ""));
			return;
		}
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
		const continuation = " ".repeat(prefixWidth);
		for (let index = 0; index < wrapped.length; index++) {
			lines.push(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
		}
	}

	private renderProgress(lines: string[], width: number): void {
		const cells = this.quiz.questions.map((question, index) => {
			const answered = this.answers.has(question.id);
			const active = index === this.questionIndex;
			const marker = answered ? "✓" : "○";
			const raw = ` ${marker} ${index + 1} `;
			return active ? this.theme.bg("selectedBg", this.theme.fg("text", raw)) : this.theme.fg(answered ? "success" : "muted", raw);
		});
		const reviewRaw = " ✓ Review ";
		cells.push(
			this.onReview
				? this.theme.bg("selectedBg", this.theme.fg("text", reviewRaw))
				: this.theme.fg(this.answers.size === this.quiz.questions.length ? "success" : "dim", reviewRaw),
		);
		this.addWrapped(lines, cells.join(" "), width, " ");
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (this.cache?.width === renderWidth) return this.cache.lines;
		const lines: string[] = [this.theme.fg("accent", "─".repeat(renderWidth))];
		const title = this.quiz.title ?? "Knowledge check";
		this.addWrapped(lines, this.theme.fg("accent", this.theme.bold(title)), renderWidth, " ");
		this.renderProgress(lines, renderWidth);
		lines.push("");

		if (this.onReview) {
			this.addWrapped(lines, this.theme.fg("accent", this.theme.bold("Review responses")), renderWidth, " ");
			lines.push("");
			for (const question of this.quiz.questions) {
				const answer = this.answers.get(question.id);
				const answerText = answer ? `${answer.optionLabel}${answer.note ? " · note attached" : ""}` : "Unanswered";
				this.addWrapped(
					lines,
					this.theme.fg(answer ? "text" : "warning", `${question.id}: ${answerText}`),
					renderWidth,
					" ",
				);
			}
			this.renderNoteSection(lines, this.reviewNote, renderWidth, "review");
			lines.push("");
			const ready = this.answers.size === this.quiz.questions.length;
			this.addWrapped(
				lines,
				this.theme.fg(ready ? "success" : "warning", ready ? "Enter submits these responses." : "Answer every question before submitting."),
				renderWidth,
				" ",
			);
		} else {
			const question = this.currentQuestion;
			if (question) {
				this.addWrapped(lines, this.theme.fg("text", question.question), renderWidth, " ");
				lines.push("");
				for (let index = 0; index < question.options.length; index++) {
					const option = question.options[index];
					const selected = index === (this.cursors[this.questionIndex] ?? 0);
					const answered = this.answers.get(question.id)?.optionId === option.id;
					const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
					const marker = answered ? "✓" : `${index + 1}.`;
					this.addWrapped(
						lines,
						this.theme.fg(selected ? "accent" : "text", `${marker} ${option.label}`),
						renderWidth,
						prefix,
					);
					if (option.description) {
						this.addWrapped(lines, this.theme.fg("muted", option.description), renderWidth, "     ");
					}
				}
				this.renderNoteSection(lines, this.notes.get(question.id), renderWidth, "question");
			}
		}

		lines.push("");
		const help = this.noteMode
			? "Enter or Tab save note · Esc discards edits"
			: this.onReview
				? "Tab review note · ← edit answer · Enter submit · Esc cancel"
				: "↑↓/1-6 choose · Enter select · ←→ review · Tab note · Esc cancel";
		this.addWrapped(lines, this.theme.fg("dim", help), renderWidth, " ");
		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
		const bounded = lines.map((line) => truncateToWidth(line, renderWidth, ""));
		this.cache = { width: renderWidth, lines: bounded };
		return bounded;
	}

	invalidate(): void {
		this.cache = undefined;
		this.editor.invalidate();
	}
}

const QuizOptionSchema = Type.Object({
	id: Type.String({
		description: "Stable option id: 1-64 letters, digits, underscores, or hyphens; must start alphanumeric",
		minLength: 1,
		maxLength: 64,
		pattern: QUIZ_ID_PATTERN,
	}),
	label: Type.String({ description: "Concise answer shown to the user", minLength: 1, maxLength: 240 }),
	description: Type.Optional(
		Type.String({ description: "Optional neutral clarification; do not reveal whether the option is correct", maxLength: 500 }),
	),
});

const QuizQuestionSchema = Type.Object({
	id: Type.String({
		description: "Stable question id: 1-64 letters, digits, underscores, or hyphens; must start alphanumeric",
		minLength: 1,
		maxLength: 64,
		pattern: QUIZ_ID_PATTERN,
	}),
	question: Type.String({ description: "The diagnostic question", minLength: 1, maxLength: 1000 }),
	options: Type.Array(QuizOptionSchema, {
		description: "Mutually distinguishable options, including an honest uncertainty/none-fit choice when appropriate",
		minItems: 2,
		maxItems: MAX_QUIZ_OPTIONS,
	}),
});

const QuizParamsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short neutral title for this diagnostic round", maxLength: 120 })),
	questions: Type.Array(QuizQuestionSchema, {
		description: "A small batch of questions that can be answered together",
		minItems: 1,
		maxItems: MAX_QUIZ_QUESTIONS,
	}),
});

type PendingQuiz = {
	quiz: QuizParams;
	progress: QuizProgress;
	autoOpenOnce: boolean;
	presenting: boolean;
	timer?: ReturnType<typeof setTimeout>;
};

const pendingBySession = new Map<string, PendingQuiz>();

export function sessionKey(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager as { getSessionId?: () => string; getSessionFile?: () => string | undefined } | undefined;
	return manager?.getSessionId?.() ?? manager?.getSessionFile?.() ?? "ephemeral";
}

export function getPendingQuiz(ctx: ExtensionContext): PendingQuiz | undefined {
	return pendingBySession.get(sessionKey(ctx));
}

function setPendingQuiz(ctx: ExtensionContext, pending: PendingQuiz): void {
	pendingBySession.set(sessionKey(ctx), pending);
}

function clearPendingQuiz(ctx: ExtensionContext): void {
	const key = sessionKey(ctx);
	const pending = pendingBySession.get(key);
	if (pending?.timer) clearTimeout(pending.timer);
	pendingBySession.delete(key);
}

function recordText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

function isSubmittedQuiz(entry: unknown): boolean {
	const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
	if (!rec) return false;
	if (rec.type === "custom_message" && rec.customType === "quiz") {
		const details = rec.details as { status?: unknown } | undefined;
		return details?.status === "submitted" || recordText(rec.content).startsWith("Quiz responses:");
	}
	const message = rec.message && typeof rec.message === "object" ? (rec.message as Record<string, unknown>) : undefined;
	if (!message) return false;
	if (message.role === "custom" && message.customType === "quiz") {
		const details = message.details as { status?: unknown } | undefined;
		return details?.status === "submitted" || recordText(message.content).startsWith("Quiz responses:");
	}
	return false;
}

function issuedQuizFrom(entry: unknown): QuizParams | undefined {
	const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
	const message = rec?.message && typeof rec.message === "object" ? (rec.message as Record<string, unknown>) : undefined;
	if (!message || message.role !== "toolResult" || message.toolName !== "quiz") return undefined;
	const details = message.details as { status?: unknown; title?: unknown; questions?: unknown } | undefined;
	if (details?.status !== "issued" || !Array.isArray(details.questions)) return undefined;
	try {
		return normalizeQuizParams({
			questions: details.questions as QuizParams["questions"],
			...(typeof details.title === "string" ? { title: details.title } : {}),
		});
	} catch {
		return undefined;
	}
}

/** Newest unanswered issued quiz on the branch, or undefined if the latest quiz activity was a submit. */
export function recoverIssuedQuiz(branch: readonly unknown[]): QuizParams | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (isSubmittedQuiz(entry)) return undefined;
		const quiz = issuedQuizFrom(entry);
		if (quiz) return quiz;
	}
	return undefined;
}

function ensurePendingQuiz(ctx: ExtensionContext): PendingQuiz | undefined {
	const existing = getPendingQuiz(ctx);
	if (existing) return existing;
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const quiz = recoverIssuedQuiz(branch);
	if (!quiz) return undefined;
	setPendingQuiz(ctx, {
		quiz,
		progress: {},
		autoOpenOnce: false,
		presenting: false,
	});
	return getPendingQuiz(ctx);
}

export function renderQuizTranscript(
	details: QuizDetails,
	expanded: boolean,
	theme: { fg(color: string, text: string): string },
): Text {
	if (details.status === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	if (details.status === "unavailable") return new Text(theme.fg("warning", "Interactive UI unavailable"), 0, 0);
	if (details.status === "issued") {
		return new Text(theme.fg("muted", "Issued · waiting for answers"), 0, 0);
	}
	let text = theme.fg("success", `✓ ${details.answers.length} response${details.answers.length === 1 ? "" : "s"}`);
	if (expanded) {
		const questions = new Map(details.questions.map((question) => [question.id, question]));
		for (const answer of details.answers) {
			const stem = questions.get(answer.questionId)?.question.replace(/\s+/g, " ").trim() ?? "";
			const heading = stem
				? `${scrubQuizText(answer.questionId)}: ${scrubQuizText(stem)}`
				: scrubQuizText(answer.questionId);
			text += `\n${theme.fg("accent", heading)}`;
			text += `\n  ${scrubQuizText(answer.optionLabel)}`;
			if (answer.note) {
				const noteLines = scrubQuizText(answer.note).split("\n");
				text += `\n  ${theme.fg("muted", `note: ${noteLines[0] ?? ""}`)}`;
				for (const line of noteLines.slice(1)) {
					text += `\n  ${theme.fg("muted", line)}`;
				}
			}
		}
		if (details.reviewNote) {
			const noteLines = scrubQuizText(details.reviewNote).split("\n");
			text += `\n${theme.fg("accent", "review note")}`;
			text += `\n  ${theme.fg("muted", noteLines[0] ?? "")}`;
			for (const line of noteLines.slice(1)) {
				text += `\n  ${theme.fg("muted", line)}`;
			}
		}
	}
	return new Text(text, 0, 0);
}

export async function collectInTui(
	quiz: QuizParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	progress: QuizProgress = {},
): Promise<QuizDetails> {
	if (signal?.aborted) return buildQuizDetails("cancelled", quiz, progress);
	let close: ((status: "submitted" | "cancelled", snapshot: QuizProgress) => void) | undefined;
	const onAbort = () => close?.("cancelled", progress);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await ctx.ui.custom<QuizDetails>((tui, theme, _keybindings, done) => {
			let settled = false;
			close = (status, snapshot) => {
				if (settled) return;
				settled = true;
				done(buildQuizDetails(status, quiz, snapshot));
			};
			return new QuizComponent(tui, theme, quiz, close, progress);
		});
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

async function presentPendingQuiz(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const pending = getPendingQuiz(ctx);
	if (!pending || pending.presenting) return;
	pending.presenting = true;
	try {
		const details = await collectInTui(pending.quiz, undefined, ctx, pending.progress);
		if (details.status === "submitted") {
			clearPendingQuiz(ctx);
			pi.sendMessage(
				{
					customType: "quiz",
					content: formatQuizResult(details),
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}
		pending.progress = {
			answers: details.answers,
			notes: details.notes,
			reviewNote: details.reviewNote,
			questionIndex: details.questionIndex,
		};
		pending.autoOpenOnce = false;
	} catch {
		// Session may have been disposed while the overlay was open.
	} finally {
		const current = getPendingQuiz(ctx);
		if (current) current.presenting = false;
	}
}

export default function quizExtension(pi: ExtensionAPI): void {
	pi.on("session_shutdown", (_event, ctx) => {
		clearPendingQuiz(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const pending = getPendingQuiz(ctx);
		if (!pending || pending.presenting) return;
		if (pending.autoOpenOnce) {
			pending.autoOpenOnce = false;
			if (pending.timer) clearTimeout(pending.timer);
			pending.timer = setTimeout(() => {
				pending.timer = undefined;
				void presentPendingQuiz(pi, ctx);
			}, 0);
			return;
		}
		ctx.ui.notify("Paused quiz · /quiz to resume", "info");
	});

	pi.registerCommand("quiz", {
		description: "Resume the paused quiz",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Quiz UI is only available in the TUI", "warning");
				return;
			}
			const pending = ensurePendingQuiz(ctx);
			if (!pending) {
				ctx.ui.notify("No paused quiz", "info");
				return;
			}
			if (pending.presenting) {
				ctx.ui.notify("Quiz is already open", "info");
				return;
			}
			await presentPendingQuiz(pi, ctx);
		},
	});

	pi.registerMessageRenderer("quiz", (message, { expanded }, theme) => {
		const details = message.details as QuizDetails | undefined;
		if (!details) return new Text(typeof message.content === "string" ? scrubQuizText(message.content) : "", 0, 0);
		return renderQuizTranscript(details, expanded, theme);
	});

	pi.registerTool({
		name: "quiz",
		label: "Quiz",
		description:
			"Issue 1-4 diagnostic multiple-choice questions to the user. This tool only presents the quiz; it does not return answers. " +
			"Call it alone, with no other tools in the same turn. After calling it, stop and wait. The user may ask other questions first. " +
			"Answers arrive later as a message beginning with \"Quiz responses:\". " +
			"Do not call quiz again until those answers arrive or the user skips the round. " +
			"During a multi-round diagnosis, reasoning may be exposed: never state answer keys, grading, corrections, or misconceptions in reasoning or text before the final diagnosis. " +
			"After a submitted round, either call quiz again with no prose or give the final diagnosis. " +
			"Do not encode correctness in labels/descriptions or use the tool to answer a quiz yourself.",
		promptGuidelines: [
			"Call quiz alone in its own turn; it terminates the turn so the user can answer.",
			"After quiz is issued, wait for a later message starting with Quiz responses:; do not immediately call quiz again.",
			"The user may chat about the topic before submitting; answer them and keep waiting for the same quiz.",
		],
		parameters: QuizParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const quiz = normalizeQuizParams(params as QuizParams);
			if (ctx.mode !== "tui") {
				const details = buildQuizDetails("unavailable", quiz);
				return {
					content: [{ type: "text", text: formatQuizResult(details) }],
					details,
				};
			}
			const existing = getPendingQuiz(ctx);
			if (existing?.timer) clearTimeout(existing.timer);
			setPendingQuiz(ctx, {
				quiz,
				progress: {},
				autoOpenOnce: true,
				presenting: existing?.presenting ?? false,
			});
			const details = buildQuizDetails("issued", quiz);
			return {
				content: [{ type: "text", text: ISSUED_QUIZ_TEXT }],
				details,
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			const title = typeof args.title === "string" && args.title.trim() ? scrubQuizText(args.title) : "Knowledge check";
			return new Text(
				theme.fg("toolTitle", theme.bold("quiz ")) +
					theme.fg("muted", `${title} · ${count} question${count === 1 ? "" : "s"}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as QuizDetails | undefined;
			if (!details) {
				const block = result.content[0];
				return new Text(block?.type === "text" ? scrubQuizText(block.text) : "", 0, 0);
			}
			return renderQuizTranscript(details, expanded, theme);
		},
	});
}
