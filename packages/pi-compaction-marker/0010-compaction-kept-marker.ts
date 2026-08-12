/**
 * Numbered compaction markers for /tree.
 *
 * pi's context compaction appends a "compaction" entry whose
 * `firstKeptEntryId` points at the first session entry that is kept verbatim
 * in LLM context; everything older is replaced by the compaction summary.
 * The stock /tree UI shows the "[compaction: Nk tokens]" node but not where
 * the kept range starts — and once a session has several compactions (serial
 * on one branch, or on sibling branches with shared cut-off history) there is
 * no way to tell which boundary belongs to which compaction.
 *
 * This extension assigns every compaction a stable ordinal — its position
 * among `compaction` entries in the append-only session file — and labels
 * BOTH ends of its kept range:
 *
 *   boundary row:     [compaction N — kept from here (~Xk)]
 *   compaction node:  [compaction N] [compaction: Xk tokens]
 *
 * Markers are immutable facts ("compaction N kept from this row, compacting
 * ~Xk tokens") and are therefore never cleared when newer compactions land:
 * serial compactions keep their full history, and compacting on one branch
 * never erases another branch's boundary. Reading rule: the highest-numbered
 * compaction on your current path is the live one — its summary plus
 * everything below its boundary marker is your context.
 *
 * Visible-row targeting: /tree normally hides assistant messages that carry
 * only thinking/tool calls and no text (except when that entry is the current
 * leaf). Split-turn cut points regularly land exactly on such entries, so the
 * boundary marker is placed on the first entry of the kept range that /tree
 * can reliably render: a user message, an assistant message with text, or an
 * assistant message with a non-normal stop reason; failing those, the first
 * toolResult; failing everything, the raw boundary
 * entry. Each compaction's kept range is walked along its OWN root path
 * (parentId chain), never the current branch.
 *
 * Behavior details:
 * - One reconcile pass (`ensureMarkers`) computes the expected label set and
 *   diffs it against existing labels. Idempotent: zero label writes when the
 *   session is already correct (no log spam, safe across processes).
 * - Shared boundary row (several compactions resolving to the same visible
 *   row — e.g. sibling branches with mutual cut-off history): merged label
 *   "compactions 1 & 2 — kept from here"; the numbered node labels keep them
 *   distinguishable.
 * - User labels are never overwritten: marker recognition is strict-pattern
 *   (plus the legacy v0.4.x "kept from here …" format, which is migrated),
 *   so a user label like "compaction notes" is never touched, and a user
 *   label sitting on a desired row wins over the marker.
 * - Runs on `session_compact` and on `session_start` (backfill for
 *   compactions that happened while the extension was not loaded, repair of
 *   v0.4.x placements).
 * - No UI calls — only session labels are touched, so the extension is safe
 *   in headless/print mode.
 */
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/** "compaction 3 — kept from here (~121k)" / "compactions 1 & 2 — kept from here" */
const BOUNDARY_RE = /^compactions? [\d, &]+ — kept from here( \(~\d+k\))?$/;
/** "compaction 3" (on the compaction node itself) */
const NODE_RE = /^compaction \d+$/;
/** v0.4.x format: "kept from here (compacted ~121k tokens)" */
const LEGACY_PREFIX = "kept from here";

function isMarkerLabel(label: string): boolean {
	return BOUNDARY_RE.test(label) || NODE_RE.test(label) || label.startsWith(LEGACY_PREFIX);
}

function hasNonEmptyText(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string" &&
			(block as { text: string }).text.trim().length > 0
		) {
			return true;
		}
	}
	return false;
}

/**
 * Entries /tree renders in (almost) every filter mode. Mirrors the
 * tree-selector's hard skip: assistant messages without text are hidden
 * unless errored/aborted; user messages are always shown.
 */
function isAlwaysVisibleInTree(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "user") return true;
	if (message.role === "assistant") {
		if (hasNonEmptyText(message.content)) return true;
		const stop = (message as { stopReason?: unknown }).stopReason;
		return typeof stop === "string" && stop !== "stop" && stop !== "toolUse";
	}
	return false;
}

/** "1" / "1 & 2" / "1, 2 & 3" */
function joinOrdinals(ordinals: number[]): string {
	if (ordinals.length === 1) return String(ordinals[0]);
	const last = ordinals[ordinals.length - 1];
	return `${ordinals.slice(0, -1).join(", ")} & ${last}`;
}

/**
 * Pick the row to carry a compaction's boundary marker: the first
 * /tree-visible entry of the kept range (boundary → compaction node) along
 * the compaction's own root path.
 */
function resolveMarkerTarget(pathRootToCompaction: SessionEntry[], firstKeptEntryId: string, compactionId: string): string {
	const start = pathRootToCompaction.findIndex((entry) => entry.id === firstKeptEntryId);
	if (start < 0) return firstKeptEntryId;

	let toolResultFallback: string | undefined;
	for (let i = start; i < pathRootToCompaction.length; i++) {
		const entry = pathRootToCompaction[i];
		if (entry === undefined || entry.id === compactionId) break;
		if (isAlwaysVisibleInTree(entry)) return entry.id;
		if (toolResultFallback === undefined && entry.type === "message" && entry.message.role === "toolResult") {
			toolResultFallback = entry.id;
		}
	}
	return toolResultFallback ?? firstKeptEntryId;
}

/** Root→compaction path via the parentId chain (independent of current branch/leaf). */
function pathTo(byId: Map<string, SessionEntry>, fromId: string): SessionEntry[] {
	const path: SessionEntry[] = [];
	let current = byId.get(fromId);
	while (current !== undefined) {
		path.push(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return path.reverse();
}

/**
 * Reconcile session labels with the expected marker set. Expected state is a
 * pure function of the entry log, so this is safe to run any number of times.
 */
function ensureMarkers(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getEntries();
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	// 1. Stable ordinals: position among compaction entries in append-only
	//    file order. Ordinals of existing compactions can never change.
	const compactions: { id: string; firstKeptEntryId: string; tokensBefore: number; ordinal: number }[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction") {
			compactions.push({
				id: entry.id,
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
				ordinal: compactions.length + 1,
			});
		}
	}

	// 2. Expected labels: node label per compaction, boundary marker per
	//    resolved target row (merged when several compactions share a row).
	const expected = new Map<string, string>();
	const byTarget = new Map<string, { ordinal: number; tokensBefore: number }[]>();
	for (const compaction of compactions) {
		expected.set(compaction.id, `compaction ${compaction.ordinal}`);
		const path = pathTo(byId, compaction.id);
		const target = resolveMarkerTarget(path, compaction.firstKeptEntryId, compaction.id);
		const group = byTarget.get(target) ?? [];
		group.push({ ordinal: compaction.ordinal, tokensBefore: compaction.tokensBefore });
		byTarget.set(target, group);
	}
	for (const [target, group] of byTarget) {
		const first = group[0];
		if (first === undefined) continue;
		expected.set(
			target,
			group.length === 1
				? `compaction ${first.ordinal} — kept from here (~${Math.round(first.tokensBefore / 1000)}k)`
				: `compactions ${joinOrdinals(group.map((g) => g.ordinal))} — kept from here`,
		);
	}

	// 3. Diff: set missing/outdated markers, clear orphaned ones, never touch
	//    user labels.
	for (const entry of entries) {
		const existing = ctx.sessionManager.getLabel(entry.id);
		const desired = expected.get(entry.id);
		if (desired !== undefined) {
			if (existing === desired) continue;
			// Respect user labels: a non-marker label on the target row wins.
			if (typeof existing === "string" && existing.length > 0 && !isMarkerLabel(existing)) continue;
			pi.setLabel(entry.id, desired);
		} else if (typeof existing === "string" && isMarkerLabel(existing)) {
			// Stale marker: legacy v0.4.x placement or superseded merge text.
			pi.setLabel(entry.id, undefined);
		}
	}
}

export default function compactionKeptMarker(pi: ExtensionAPI) {
	const run = (ctx: ExtensionContext): void => {
		try {
			ensureMarkers(pi, ctx);
		} catch (error) {
			console.error("[0010-compaction-kept-marker]", error);
		}
	};
	pi.on("session_compact", (_event, ctx) => run(ctx));
	pi.on("session_start", (_event, ctx) => run(ctx));
}
