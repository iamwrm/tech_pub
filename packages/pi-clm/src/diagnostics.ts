import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { comparePayload, count, fingerprintPayload, hashJson, isRecord, payloadSummary, routingHeaderHashes, type PayloadFingerprint } from "./diagnostic-fingerprint.ts";

import { reconstructLiveContextState } from "./state.ts";

export const DIAGNOSTIC_SINK_EVENT = "pi-clm:diagnostics-sink:v1";
const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 32;

type Stage = "provider-hook" | "terminal";
interface Identity { provider?: string; api?: string; model?: string }
interface PendingRequest { id: number; payloadHash: string; model: unknown; identity: Identity; responseIdHash?: string }
interface TerminalPacket extends Identity { version: 1; sessionId: string; pipelinePayloadHash: string; payload: unknown; transport?: string; baseUrlHash?: string }
export interface DiagnosticOptions { enabled?: boolean; directory?: string; maxBytes?: number }

function identity(ctx: ExtensionContext): Identity {
	return { provider: ctx.model?.provider, api: ctx.model?.api, model: ctx.model?.id };
}

function clmState(ctx: ExtensionContext) {
	const state = reconstructLiveContextState(ctx.sessionManager.getBranch());
	return {
		revision: state.revision,
		enabled: state.enabled,
		sourceMessageCount: state.checkpoint?.sourceMessageCount,
		projectedMessageCount: state.checkpoint?.projectedMessages.length,
	};
}

export class DiagnosticSession {
	readonly filePath: string;
	private fd: number | undefined;
	private bytes = 0;
	private sequence = 0;
	private baselines = new Map<string, PayloadFingerprint>();
	private pending: PendingRequest[] = [];
	private responses = new Map<string, PendingRequest | undefined>();
	error?: string;
	truncated = false;

	constructor(readonly sessionId: string, directory: string, private readonly maxBytes = MAX_TRACE_BYTES) {
		const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "session";
		const folder = join(resolve(directory), safeId);
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		this.filePath = join(folder, `${Date.now()}-${process.pid}-${randomUUID()}.jsonl`);
		this.fd = openSync(this.filePath, "wx", 0o600);
		this.write({ event: "start", version: 1, packageVersion: "1.0.0-ren.3", upstreamCommit: "b84a9d7cbb625cd39539db3bcef72ea9cc89aa89", piVersion: VERSION, node: process.versions.node, platform: process.platform, arch: process.arch });
	}

	write(record: Record<string, unknown>): void {
		if (this.fd === undefined || this.truncated || this.error) return;
		try {
			const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
			if (this.bytes + Buffer.byteLength(line) > this.maxBytes) { this.truncated = true; return; }
			appendFileSync(this.fd, line);
			this.bytes += Buffer.byteLength(line);
		} catch { this.error = "trace_write_failed"; }
	}

	capture(stage: Stage, payload: unknown, who: Identity, state?: ReturnType<typeof clmState>, pipelinePayloadHash?: string, transport?: string, baseUrlHash?: string): void {
		if (this.fd === undefined || this.truncated || this.error) return;
		try {
			const fp = fingerprintPayload(payload);
			const model = isRecord(payload) ? payload.model : undefined;
			const candidates = stage === "terminal" ? this.pending.filter((item) => item.payloadHash === pipelinePayloadHash && !item.responseIdHash) : [];
			// A later provider hook can rewrite the body after our observation. Only
			// use the weaker route match when exactly one request is pending there.
			const routeCandidates = stage === "terminal" ? this.pending.filter((item) => !item.responseIdHash && item.model === model && item.identity.provider === who.provider && item.identity.api === who.api) : [];
			const request = candidates.length === 1 ? candidates[0] : candidates.length === 0 && routeCandidates.length === 1 ? routeCandidates[0] : undefined;
			const requestId = request?.id ?? ++this.sequence;
			const route = hashJson({ provider: who.provider, api: who.api, model });
			const key = `${stage}:${route}`;
			this.write({
				event: "request", stage, requestId, ...who, clm: state,
				...payloadSummary(fp), comparison: comparePayload(this.baselines.get(key), fp),
				...(stage === "terminal" ? { pipelinePayloadHash, pipelineCorrelation: candidates.length === 1 ? "unique-hash-match" : request ? "unique-pending-route" : candidates.length > 1 || routeCandidates.length > 1 ? "ambiguous" : "unmatched", pipelineCandidateCount: candidates.length, routeCandidateCount: routeCandidates.length, transport, baseUrlHash } : {}),
			});
			this.baselines.set(key, fp);
			if (this.baselines.size > MAX_PENDING_REQUESTS) this.baselines.delete(this.baselines.keys().next().value!);
			if (request) { request.identity = who; request.model = model; }
			else this.pending.push({ id: requestId, payloadHash: fp.payloadHash, model, identity: who });
			if (this.pending.length > MAX_PENDING_REQUESTS) this.pending.shift();
		} catch { this.write({ event: "diagnostic_error", operation: "fingerprint", code: "unsupported_payload" }); }
	}

	providerEvent(data: unknown, who: Required<Identity>): void {
		if (this.fd === undefined || this.truncated || this.error || !isRecord(data)) return;
		const type = data.type;
		if (!["response.created", "response.completed", "response.done", "response.failed", "error"].includes(String(type))) return;
		const response = isRecord(data.response) ? data.response : {};
		const responseId = typeof response.id === "string" ? hashJson(response.id) : undefined;
		if (type === "response.created" && responseId) {
			const candidates = this.pending.filter((request) => !request.responseIdHash && request.model === who.model && request.identity.provider === who.provider && request.identity.api === who.api);
			const match = candidates.length === 1 ? candidates[0] : undefined;
			if (match) match.responseIdHash = responseId;
			this.responses.set(responseId, match);
			if (this.responses.size > MAX_PENDING_REQUESTS) this.responses.delete(this.responses.keys().next().value!);
			this.write({ event: "response_start", ...who, responseIdHash: responseId, requestId: match?.id, correlation: match ? "unique-pending-request" : "ambiguous-or-unmatched", candidateCount: candidates.length });
			return;
		}
		const request = responseId ? this.responses.get(responseId) : undefined;
		const usage = isRecord(response.usage) ? response.usage : {};
		const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
		const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
		const inputTokens = count(usage.input_tokens);
		const cachedTokens = count(details.cached_tokens);
		this.write({
			event: "response_usage", ...who, responseEvent: type, responseIdHash: responseId, requestId: request?.id,
			inputTokens, cachedTokens, outputTokens: count(usage.output_tokens), reasoningTokens: count(outputDetails.reasoning_tokens),
			reportedServiceTier: typeof response.service_tier === "string" ? (["default", "priority", "auto", "flex"].includes(response.service_tier) ? response.service_tier : "other") : undefined,
			cacheHitRatio: inputTokens && cachedTokens !== undefined ? cachedTokens / inputTokens : undefined,
			...(response.prompt_cache_diagnostics !== undefined ? { cacheDiagnosticsHash: hashJson(response.prompt_cache_diagnostics) } : {}),
		});
		if (request) this.pending = this.pending.filter((item) => item !== request);
		if (responseId) this.responses.delete(responseId);
	}

	close(): void {
		if (this.fd !== undefined) { try { closeSync(this.fd); } catch {} this.fd = undefined; }
		this.pending = [];
		this.responses.clear();
		this.baselines.clear();
	}
}

/** Observation only: never replaces payloads, headers, messages, settings, or session entries. */
export function installDiagnostics(pi: ExtensionAPI, options: DiagnosticOptions = {}): void {
	let enabled = options.enabled ?? !["0", "false", "off", "no"].includes(process.env.PI_CLM_DIAGNOSTICS?.trim().toLowerCase() ?? "");
	const directory = options.directory ?? process.env.PI_CLM_TRACE_DIR ?? join(getAgentDir(), "pi-clm-traces");
	let trace: DiagnosticSession | undefined;
	let currentState: ReturnType<typeof clmState> | undefined;
	let unsubscribe: (() => void) | undefined;
	let startupError: string | undefined;
	const close = () => { unsubscribe?.(); unsubscribe = undefined; trace?.close(); trace = undefined; currentState = undefined; };
	const begin = (ctx: ExtensionContext) => {
		close();
		startupError = undefined;
		if (!enabled) return;
		try {
			trace = new DiagnosticSession(ctx.sessionManager.getSessionId(), directory, options.maxBytes);
			unsubscribe = pi.events.on(DIAGNOSTIC_SINK_EVENT, (query) => {
				if (!trace || !isRecord(query) || query.version !== 1 || query.sessionId !== trace.sessionId || typeof query.reply !== "function") return;
				query.reply((packet: TerminalPacket) => {
					if (!trace || packet.version !== 1 || packet.sessionId !== trace.sessionId) return;
					trace.capture("terminal", packet.payload, { provider: packet.provider, api: packet.api, model: packet.model }, currentState, packet.pipelinePayloadHash, packet.transport, packet.baseUrlHash);
				});
			});
		} catch { close(); startupError = "trace_initialization_failed"; }
	};

	const observe = (operation: string, run: () => void) => {
		try { run(); } catch { trace?.write({ event: "diagnostic_error", operation, code: "observation_failed" }); }
	};
	pi.on("session_start", (_event, ctx) => { begin(ctx); });
	pi.on("session_shutdown", () => { close(); });
	pi.on("session_tree", (_event, ctx) => { observe("branch_change", () => { trace?.write({ event: "branch_change", clm: clmState(ctx) }); }); });
	pi.on("session_compact", (_event, ctx) => { observe("native_compaction", () => { trace?.write({ event: "native_compaction", clm: clmState(ctx) }); }); });
	pi.on("before_provider_request", (event, ctx) => {
		observe("request", () => {
			if (!trace) return;
			currentState = clmState(ctx);
			trace.capture("provider-hook", event.payload, identity(ctx), currentState);
		});
	});
	pi.on("before_provider_headers", (event) => { observe("request_headers", () => { trace?.write({ event: "request_headers", routingHashes: routingHeaderHashes(event.headers) }); }); });
	pi.on("after_provider_response", (event) => { observe("response_headers", () => { trace?.write({ event: "response_headers", status: event.status, routingHashes: routingHeaderHashes(event.headers) }); }); });
	pi.on("provider_stream_event", (event) => { observe("provider_event", () => { trace?.providerEvent(event.data, { provider: event.provider, api: event.api, model: event.model }); }); });
	pi.on("message_end", (event) => {
		observe("assistant_usage", () => {
			if (!trace || event.message.role !== "assistant") return;
			const message = event.message;
			trace.write({ event: "assistant_usage", provider: message.provider, api: message.api, model: message.model, stopReason: message.stopReason, input: count(message.usage.input), output: count(message.usage.output), cacheRead: count(message.usage.cacheRead), cacheWrite: count(message.usage.cacheWrite) });
		});
	});
	pi.registerCommand("clm-trace", {
		description: "Hash-only CLM/cache diagnostics: status, on, off",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "on") { enabled = true; if (!trace) begin(ctx); }
			else if (action === "off") { enabled = false; close(); }
			else if (action !== "status") { ctx.ui.notify("Usage: /clm-trace [status|on|off]", "warning"); return; }
			const status = startupError ?? trace?.error ?? (trace?.truncated ? "size limit reached" : enabled ? "on" : "off");
			ctx.ui.notify(`CLM diagnostics ${status}${trace ? `\n${trace.filePath}` : ""}\nHash-only traces. Managed continuity uses stable placement; reasoning replay is unchanged.`, startupError || trace?.error ? "error" : "info");
		},
	});
}
