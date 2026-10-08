import type { LiveContextMessage } from "./types.ts";

/**
 * Protect the original objective and the user's latest instruction. When there is only
 * one user message this naturally produces one protected index.
 */
export function selectProtectedMessageIndexes(messages: LiveContextMessage[]): Set<number> {
	const userIndexes = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => message.role === "user")
		.map(({ index }) => index);

	const protectedIndexes = new Set<number>();
	const first = userIndexes[0];
	const latest = userIndexes.at(-1);
	if (first !== undefined) protectedIndexes.add(first);
	if (latest !== undefined) protectedIndexes.add(latest);
	return protectedIndexes;
}

/**
 * Messages Pi drops from the provider request (bash executions run with the exclusion
 * prefix) must also stay out of the mirror, the shrink accounting, and the projection.
 * Editing such a message would otherwise convert it to a context note and re-admit
 * deliberately excluded content into LLM context.
 */
export function selectContextVisibleMessages(messages: LiveContextMessage[]): LiveContextMessage[] {
	return messages.filter(
		(message) => !(message.role === "bashExecution" && message.excludeFromContext === true),
	);
}

export const DEFAULT_PRESSURE_TIERS: readonly number[] = [50, 75];

/** Escalating context-pressure tiers. A tier re-arms after usage drops back below it. */
export class PressureTracker {
	private fired = new Set<number>();

	constructor(private readonly tiers: readonly number[] = DEFAULT_PRESSURE_TIERS) {}

	reset(): void {
		this.fired.clear();
	}

	/** Returns the highest newly crossed tier, or undefined when no tier fires. */
	observe(percent: number | null | undefined): number | undefined {
		if (percent === null || percent === undefined) return undefined;
		this.fired = new Set([...this.fired].filter((tier) => percent >= tier));
		const crossed = this.tiers.filter((tier) => percent >= tier && !this.fired.has(tier));
		if (crossed.length === 0) return undefined;
		const top = Math.max(...crossed);
		for (const tier of this.tiers.filter((candidate) => candidate <= top)) this.fired.add(tier);
		return top;
	}
}

export function shouldAcceptShrink(
	beforeEstimate: number,
	afterEstimate: number,
	minSavings = 1,
	unit: "characters" | "tokens" = "characters",
): { accepted: boolean; savings: number; reason?: string } {
	const savings = beforeEstimate - afterEstimate;
	if (savings < Math.max(1, minSavings)) {
		return {
			accepted: false,
			savings,
			reason:
				afterEstimate > beforeEstimate
					? `Context edit grew the projection by ${afterEstimate - beforeEstimate} estimated ${unit}.`
					: `Context edit did not reduce the projection's estimated ${unit} (${beforeEstimate}→${afterEstimate}).`,
		};
	}
	return { accepted: true, savings };
}
