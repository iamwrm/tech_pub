import type { LiveContextMessage } from "./types.ts";

/**
 * Keep managed notes outside the editable mirror, but inside a stable request
 * prefix. Appending them to each new tail moves a user-message boundary on every
 * tool round; Codex can then miss the cache for the entire conversation.
 *
 * A validated projection supplies its fixed prefix length. Without one, put the
 * note before the raw conversation. Annotation changes and new projections may
 * invalidate this prefix once; ordinary appended messages must not move it.
 */
export function placeContinuityMessage(
	messages: LiveContextMessage[],
	continuity: LiveContextMessage | undefined,
	projectedPrefixLength = 0,
): LiveContextMessage[] {
	if (!continuity) return messages;
	const index = Math.min(messages.length, Math.max(0, projectedPrefixLength));
	return [...messages.slice(0, index), continuity, ...messages.slice(index)];
}
