import { resolve } from "node:path";

/**
 * What a tool call does to the mirror file.
 *
 * - "write": the call mutates the mirror (edit/write tools, or a bash command with an
 *   explicit write indicator). Counted toward the one-write-per-turn limit.
 * - "read": a bash command references the mirror without a recognized write indicator
 *   (header discovery, grep, head). Allowed and never counted, so inspection cannot
 *   consume the write allowance.
 * - "none": the call does not reference the mirror.
 *
 * Bash classification is a heuristic on command text; validation at turn_end remains
 * the correctness boundary regardless of how a mutation was performed.
 */
export type MirrorToolIntent = "write" | "read" | "none";

const WRITE_INDICATOR =
	/(?:>>?|\btee\b|\bsed\s+(?:-\S+\s+)*-i\b|\bperl\s+(?:-\S+\s+)*-i\b|\btruncate\b|\brm\b|\bmv\b|\bcp\b|\bdd\b|write_text\s*\(|\.write\s*\(|\bwritelines\s*\(|\bopen\s*\([^()]*,\s*["'][wa])/;

export function classifyMirrorToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	mirrorPath: string,
): MirrorToolIntent {
	if (toolName === "edit" || toolName === "write") {
		const rawPath = typeof input.path === "string" ? input.path.replace(/^@/, "") : "";
		return rawPath && resolve(cwd, rawPath) === mirrorPath ? "write" : "none";
	}
	if (toolName !== "bash" || typeof input.command !== "string") return "none";
	const command = input.command;
	if (!command.includes(mirrorPath) && !command.includes("LIVE_CONTEXT.md")) return "none";
	return WRITE_INDICATOR.test(command) ? "write" : "read";
}
