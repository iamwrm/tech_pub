import { randomBytes } from "node:crypto";

import { canonicalMessage, digestMessages, renderMessage } from "./context-document.ts";
import type { LiveContextMessage } from "./types.ts";

export const LIVE_CONTEXT_ANNOTATION = "live-context-annotation";
export const MAX_PIN_SOURCE_TOKENS = 8_000;
export const DEFAULT_RECALL_TOKENS = 2_000;
export const MIN_RECALL_TOKENS = 128;
export const MAX_RECALL_TOKENS = 8_000;
export const CONTINUITY_SIZE_WARNING_TOKENS = 8_000;

export type LiveContextRetention = "pin" | "continuity" | "archive";

export interface LiveContextSourceReference {
	sessionId: string;
	entryId: string;
	revision: number;
	contentHash: string;
	role: string;
}

/**
 * A full append-only annotation snapshot. Resolving an annotation appends a new
 * snapshot with the same id rather than changing the earlier session entry.
 */
export interface LiveContextAnnotation {
	version: 1;
	id: string;
	source: LiveContextSourceReference;
	title: string;
	reason: string;
	futureAction: string;
	retention: LiveContextRetention;
	createdAt: string;
	resolvedAt?: string;
	resolution?: string;
}

export interface ContinuitySessionEntryLike {
	type?: string;
	id?: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
	content?: unknown;
	display?: boolean;
	details?: unknown;
	summary?: unknown;
	fromId?: unknown;
	tokensBefore?: unknown;
}

export interface RecallFormatResult {
	text: string;
	truncated: boolean;
	totalTokens: number;
	returnedTokens: number;
}

/** Warn once per aggregate-note threshold crossing; re-arm after it shrinks below. */
export class ContinuitySizeTracker {
	private warned = false;

	constructor(readonly threshold = CONTINUITY_SIZE_WARNING_TOKENS) {}

	reset(): void {
		this.warned = false;
	}

	observe(tokens: number): boolean {
		if (!Number.isFinite(tokens) || tokens < this.threshold) {
			this.warned = false;
			return false;
		}
		if (this.warned) return false;
		this.warned = true;
		return true;
	}
}

const RETENTIONS = new Set<LiveContextRetention>(["pin", "continuity", "archive"]);
const ANNOTATION_ID_RE = /^lc-[a-f0-9]{12}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function sourceContentHash(message: LiveContextMessage): string {
	return digestMessages([message]);
}

export function isLiveContextAnnotation(value: unknown): value is LiveContextAnnotation {
	if (!value || typeof value !== "object") return false;
	const annotation = value as Partial<LiveContextAnnotation>;
	const source = annotation.source as Partial<LiveContextSourceReference> | undefined;
	return (
		annotation.version === 1 &&
		typeof annotation.id === "string" &&
		ANNOTATION_ID_RE.test(annotation.id) &&
		Boolean(source) &&
		typeof source?.sessionId === "string" &&
		typeof source.entryId === "string" &&
		Number.isInteger(source.revision) &&
		(source.revision ?? -1) >= 0 &&
		typeof source.contentHash === "string" &&
		HASH_RE.test(source.contentHash) &&
		typeof source.role === "string" &&
		typeof annotation.title === "string" &&
		typeof annotation.reason === "string" &&
		typeof annotation.futureAction === "string" &&
		typeof annotation.retention === "string" &&
		RETENTIONS.has(annotation.retention as LiveContextRetention) &&
		typeof annotation.createdAt === "string" &&
		(annotation.resolvedAt === undefined || typeof annotation.resolvedAt === "string") &&
		(annotation.resolution === undefined || typeof annotation.resolution === "string")
	);
}

/** Latest valid snapshot for each id wins on the supplied Pi branch. */
export function reconstructLiveContextAnnotations(
	entries: ContinuitySessionEntryLike[],
): LiveContextAnnotation[] {
	const latest = new Map<string, LiveContextAnnotation>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LIVE_CONTEXT_ANNOTATION) continue;
		if (!isLiveContextAnnotation(entry.data)) continue;
		latest.set(entry.data.id, entry.data);
	}
	return [...latest.values()];
}

export function activeContinuityAnnotations(
	annotations: LiveContextAnnotation[],
): LiveContextAnnotation[] {
	return annotations.filter(
		(annotation) => annotation.resolvedAt === undefined && annotation.retention !== "archive",
	);
}

export function createAnnotation(options: {
	existingIds: Iterable<string>;
	source: LiveContextSourceReference;
	title: string;
	reason: string;
	futureAction: string;
	retention: LiveContextRetention;
	createdAt?: string;
}): LiveContextAnnotation {
	const existingIds = new Set(options.existingIds);
	let id: string;
	do id = `lc-${randomBytes(6).toString("hex")}`;
	while (existingIds.has(id));
	const annotation: LiveContextAnnotation = {
		version: 1,
		id,
		source: { ...options.source },
		title: options.title,
		reason: options.reason,
		futureAction: options.futureAction,
		retention: options.retention,
		createdAt: options.createdAt ?? new Date().toISOString(),
	};
	JSON.stringify(annotation);
	return annotation;
}

export function resolveAnnotation(
	annotation: LiveContextAnnotation,
	resolution: string | undefined,
	resolvedAt = new Date().toISOString(),
): LiveContextAnnotation {
	const resolved: LiveContextAnnotation = {
		...annotation,
		source: { ...annotation.source },
		resolvedAt,
	};
	if (resolution) resolved.resolution = resolution;
	JSON.stringify(resolved);
	return resolved;
}

function timestampFromEntry(entry: ContinuitySessionEntryLike): number {
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Reconstruct the AgentMessage-shaped source represented by a durable Pi entry. */
export function messageFromSessionEntry(
	entry: ContinuitySessionEntryLike | undefined,
): LiveContextMessage | undefined {
	if (!entry) return undefined;
	if (entry.type === "message" && entry.message && typeof entry.message === "object") {
		const message = entry.message as LiveContextMessage;
		return typeof message.role === "string" ? message : undefined;
	}
	if (entry.type === "custom_message" && typeof entry.customType === "string") {
		return {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display === true,
			details: entry.details,
			timestamp: timestampFromEntry(entry),
		};
	}
	if (entry.type === "compaction" && typeof entry.summary === "string") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
			timestamp: timestampFromEntry(entry),
		};
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return {
			role: "branchSummary",
			summary: entry.summary,
			fromId: typeof entry.fromId === "string" ? entry.fromId : "",
			timestamp: timestampFromEntry(entry),
		};
	}
	return undefined;
}

/** Find the durable active-branch entry that exactly produced a mirror message. */
export function findSourceEntry(
	entries: ContinuitySessionEntryLike[],
	message: LiveContextMessage,
): ContinuitySessionEntryLike | undefined {
	const canonical = canonicalMessage(message);
	return entries.find((entry) => {
		if (typeof entry.id !== "string") return false;
		const candidate = messageFromSessionEntry(entry);
		return candidate !== undefined && canonicalMessage(candidate) === canonical;
	});
}

export function findEntryById(
	entries: ContinuitySessionEntryLike[],
	entryId: string,
): ContinuitySessionEntryLike | undefined {
	return entries.find((entry) => entry.id === entryId);
}

export function validateAnnotationSource(
	annotation: LiveContextAnnotation,
	entry: ContinuitySessionEntryLike | undefined,
): LiveContextMessage {
	const message = messageFromSessionEntry(entry);
	if (!message) throw new Error(`Source entry ${annotation.source.entryId} is unavailable.`);
	if (sourceContentHash(message) !== annotation.source.contentHash) {
		throw new Error(`Source entry ${annotation.source.entryId} failed its content-hash check.`);
	}
	return message;
}

function compactLine(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatContinuityMessage(options: {
	annotations: LiveContextAnnotation[];
	entries: ContinuitySessionEntryLike[];
	effectiveMessages: LiveContextMessage[];
}): string | undefined {
	const active = activeContinuityAnnotations(options.annotations);
	if (active.length === 0) return undefined;
	const effectiveHashes = active.some((annotation) => annotation.retention === "pin")
		? new Set(options.effectiveMessages.map(sourceContentHash))
		: new Set<string>();
	const sections = [
		"[LIVE CONTEXT CONTINUITY — extension-managed; not editable through LIVE_CONTEXT.md]",
	];
	for (const annotation of active) {
		sections.push(
			`- [${annotation.id}] ${annotation.retention}: ${compactLine(annotation.title, 120)}`,
			`  Why: ${compactLine(annotation.reason, 240)}`,
			`  Next: ${compactLine(annotation.futureAction, 240)}`,
			`  Source: ${annotation.source.entryId} · recall with live_context_recall({ id: "${annotation.id}" })`,
		);
		if (annotation.retention !== "pin") continue;
		const entry = findEntryById(options.entries, annotation.source.entryId);
		try {
			const source = validateAnnotationSource(annotation, entry);
			if (effectiveHashes.has(annotation.source.contentHash)) {
				sections.push("  Exact pinned source is already present in the projected conversation.");
			} else {
				sections.push(
					`  Exact pinned source (${annotation.source.role}):`,
					"  <live-context-pinned-source>",
					renderMessage(source),
					"  </live-context-pinned-source>",
				);
			}
		} catch (error) {
			sections.push(`  Pin unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return sections.join("\n");
}

export function formatRecall(options: {
	annotation: LiveContextAnnotation;
	source: LiveContextMessage;
	maxTokens: number;
	estimateTokens(text: string): number;
}): RecallFormatResult {
	const { annotation, source, estimateTokens } = options;
	const requestedTokens = Number.isFinite(options.maxTokens) ? Math.floor(options.maxTokens) : DEFAULT_RECALL_TOKENS;
	const maxTokens = Math.max(MIN_RECALL_TOKENS, Math.min(MAX_RECALL_TOKENS, requestedTokens));
	const header = [
		`[live-context recall ${annotation.id}]`,
		`source: session ${annotation.source.sessionId} · entry ${annotation.source.entryId} · revision ${annotation.source.revision}`,
		`hash: ${annotation.source.contentHash}`,
		`retention: ${annotation.retention}`,
		`title: ${compactLine(annotation.title, 120)}`,
		"",
		`--- exact textual source (${annotation.source.role}) ---`,
	].join("\n");
	const body = renderMessage(source);
	const full = `${header}\n${body}`;
	const totalTokens = estimateTokens(full);
	if (totalTokens <= maxTokens) {
		return { text: full, truncated: false, totalTokens, returnedTokens: totalTokens };
	}

	const marker = "\n\n[source truncated to the requested token bound; the durable Pi entry remains authoritative]";
	let low = 0;
	let high = body.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (estimateTokens(`${header}\n${body.slice(0, middle)}${marker}`) <= maxTokens) low = middle;
		else high = middle - 1;
	}
	let text = `${header}\n${body.slice(0, low)}${marker}`;
	// Defensive fallback for estimators whose result is not perfectly monotonic.
	while (low > 0 && estimateTokens(text) > maxTokens) {
		low = Math.max(0, low - Math.max(1, Math.ceil(low / 20)));
		text = `${header}\n${body.slice(0, low)}${marker}`;
	}
	if (estimateTokens(text) > maxTokens) {
		const fallbackMarker = "\n[recall truncated; durable Pi entry remains authoritative]";
		let fallbackLow = 0;
		let fallbackHigh = full.length;
		while (fallbackLow < fallbackHigh) {
			const middle = Math.ceil((fallbackLow + fallbackHigh) / 2);
			if (estimateTokens(`${full.slice(0, middle)}${fallbackMarker}`) <= maxTokens) fallbackLow = middle;
			else fallbackHigh = middle - 1;
		}
		text = `${full.slice(0, fallbackLow)}${fallbackMarker}`;
		if (estimateTokens(text) > maxTokens) text = "";
	}
	return {
		text,
		truncated: true,
		totalTokens,
		returnedTokens: estimateTokens(text),
	};
}
