/**
 * Observation cap: bound the size of each tool result in the *effective* context.
 *
 * One assistant turn can fan out into many parallel tool calls whose results land in the
 * context together, before any turn-boundary reminder can be acted on. Capping each
 * result in the effective context (not in raw history) keeps such a turn from jumping
 * straight past the budget. The full output stays in Pi's session; the marker tells the
 * model how much was cut and that it can re-read with offset/limit when it needs more.
 *
 * Capped messages are cached per source object so repeated context calls produce the
 * same object, which keeps identity-based comparisons and rendering stable.
 */

import type { LiveContextMessage } from "./types.ts";

export interface ObservationCapPolicy {
	/** Maximum characters of text kept per tool result. `undefined` disables the cap. */
	maxCharacters?: number;
	/** Fraction of the kept text taken from the start; the rest comes from the end. */
	headFraction: number;
}

export const DEFAULT_OBSERVATION_CAP: ObservationCapPolicy = { headFraction: 0.8 };

/** `PI_CLM_OBSERVATION_CAP=10000` or `10000:0.5` (characters[:head fraction]); the paper used 5k+5k, i.e. `10000:0.5`. */
export function observationCapFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ObservationCapPolicy> {
	const raw = env.PI_CLM_OBSERVATION_CAP?.trim();
	if (!raw || raw === "off" || raw === "0") return {};
	const [charsPart, headPart] = raw.split(":");
	const value = Number(charsPart);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`PI_CLM_OBSERVATION_CAP must be a positive number of characters[:head fraction] or "off", got ${raw}`);
	}
	const overrides: Partial<ObservationCapPolicy> = { maxCharacters: Math.floor(value) };
	if (headPart !== undefined && headPart !== "") {
		const head = Number(headPart);
		if (!(head > 0 && head <= 1)) throw new Error(`PI_CLM_OBSERVATION_CAP head fraction must be in (0, 1], got ${headPart}`);
		overrides.headFraction = head;
	}
	return overrides;
}

export function resolveObservationCap(overrides: Partial<ObservationCapPolicy> | undefined): ObservationCapPolicy {
	const merged = { ...DEFAULT_OBSERVATION_CAP, ...(overrides ?? {}) };
	if (merged.maxCharacters !== undefined && (!Number.isFinite(merged.maxCharacters) || merged.maxCharacters < 200)) {
		throw new Error(`observation cap must be at least 200 characters, got ${String(merged.maxCharacters)}`);
	}
	if (!(merged.headFraction > 0 && merged.headFraction <= 1)) {
		throw new Error(`headFraction must be in (0, 1], got ${String(merged.headFraction)}`);
	}
	return merged;
}

interface TextPart {
	type: "text";
	text: string;
}

function isTextPart(part: unknown): part is TextPart {
	return Boolean(part) && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string";
}

export function truncationMarker(shown: number, total: number): string {
	return (
		`\n\n[pi-clm observation cap: ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters shown. ` +
		"The complete output remains in the session history; re-read the source with offset/limit if you need the rest.]"
	);
}

/** Cap one tool result. Returns the same object when nothing changes. */
export function capToolResult(message: LiveContextMessage, policy: ObservationCapPolicy): LiveContextMessage {
	if (policy.maxCharacters === undefined || message.role !== "toolResult") return message;
	const content = message.content;
	const parts: unknown[] = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
	const total = parts.reduce<number>((sum, part) => sum + (isTextPart(part) ? part.text.length : 0), 0);
	if (total <= policy.maxCharacters) return message;

	let remaining = policy.maxCharacters;
	const headBudget = Math.floor(policy.maxCharacters * policy.headFraction);
	const tailBudget = policy.maxCharacters - headBudget;
	// Gather all text, cut once across the concatenation, then rebuild a single text part
	// (plus any non-text parts, e.g. images, preserved in order after it).
	const text = parts.filter(isTextPart).map((part) => part.text).join("");
	const head = text.slice(0, headBudget);
	const tail = tailBudget > 0 ? text.slice(text.length - tailBudget) : "";
	remaining = head.length + tail.length;
	const cut = tailBudget > 0 ? `${head}\n…[${(text.length - remaining).toLocaleString("en-US")} characters omitted]…\n${tail}` : head;
	const capped = `${cut}${truncationMarker(remaining, total)}`;
	const nonText = parts.filter((part) => !isTextPart(part));
	return {
		...message,
		content: [{ type: "text", text: capped }, ...nonText],
	};
}

const cappedCache = new WeakMap<LiveContextMessage, Map<number, LiveContextMessage>>();

/** Cap every tool result in `messages`; unchanged messages are returned as-is. */
export function capObservations(messages: LiveContextMessage[], policy: ObservationCapPolicy): LiveContextMessage[] {
	if (policy.maxCharacters === undefined) return messages;
	let changed = false;
	const output = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		let perCap = cappedCache.get(message);
		if (!perCap) {
			perCap = new Map();
			cappedCache.set(message, perCap);
		}
		let capped = perCap.get(policy.maxCharacters!);
		if (!capped) {
			capped = capToolResult(message, policy);
			perCap.set(policy.maxCharacters!, capped);
		}
		if (capped !== message) changed = true;
		return capped;
	});
	return changed ? output : messages;
}
