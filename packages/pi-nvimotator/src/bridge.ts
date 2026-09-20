import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import type { MessageSnapshot } from "./assistant-message.ts";
import { FeedbackError, type FeedbackWrapper } from "./feedback.ts";
import {
  CONNECTION_TIMEOUT_MS,
  MAX_CONCURRENT_CONNECTIONS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
  QUICK_ACTIONS,
  errorResponse,
  parseRequest,
  type BridgeManifest,
  type BridgeRequest,
  type BridgeResponse,
} from "./protocol.ts";
import {
  prepareSocketPath,
  publishManifest,
  releaseReservation,
  removeManifest,
  removeSocket,
  reserveBridgeId,
  secureBoundSocket,
  updateManifest,
  type RegistryReservation,
  type SocketIdentity,
} from "./registry.ts";
import { SubmissionError, SubmissionStore } from "./submission.ts";

export type BridgeState = "starting" | "running" | "stopping" | "stopped";

export interface NvimotatorBridgeOptions {
  snapshot: MessageSnapshot;
  onSubmit: (prompt: string) => void;
  onClosed?: () => void;
  feedbackWrapper?: FeedbackWrapper;
}

function tokensMatch(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export class NvimotatorBridge {
  private snapshot: MessageSnapshot;
  private readonly options: NvimotatorBridgeOptions;
  private readonly token = randomBytes(32).toString("hex");
  private readonly instanceId = randomUUID();
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private state: BridgeState = "stopped";
  private manifest?: BridgeManifest;
  private manifestFile?: string;
  private socketPath?: string;
  private socketIdentity?: SocketIdentity;
  private reservation?: RegistryReservation;
  private submissions: SubmissionStore;
  private startPromise?: Promise<BridgeManifest>;
  private stopPromise?: Promise<void>;

  constructor(options: NvimotatorBridgeOptions) {
    this.options = options;
    this.snapshot = options.snapshot;
    this.submissions = new SubmissionStore(this.snapshot, options.feedbackWrapper);
    this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
  }

  getState(): BridgeState { return this.state; }
  isActive(): boolean { return this.state === "running"; }
  getManifest(): BridgeManifest | undefined { return this.manifest; }

  async start(): Promise<BridgeManifest> {
    if (this.state === "running" && this.manifest) return this.manifest;
    if (this.state === "starting" && this.startPromise) return this.startPromise;
    if (this.state === "stopping") throw new Error("Nvimotator bridge is stopping.");
    this.state = "starting";
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } catch (error) {
      this.state = "stopped";
      await this.closeServer();
      await removeSocket(this.socketPath, this.socketIdentity).catch(() => undefined);
      if (this.reservation) await releaseReservation(this.reservation).catch(() => undefined);
      throw error;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<BridgeManifest> {
    this.reservation = await reserveBridgeId();
    this.socketPath = await prepareSocketPath(this.reservation);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.server.off("listening", ready); reject(error); };
      const ready = () => { this.server.off("error", fail); resolve(); };
      this.server.once("error", fail);
      this.server.once("listening", ready);
      this.server.listen(this.socketPath!);
    });
    this.socketIdentity = await secureBoundSocket(this.socketPath);
    const manifest: BridgeManifest = {
      protocolVersion: PROTOCOL_VERSION,
      bridgeId: this.reservation.bridgeId,
      instanceId: this.instanceId,
      sessionId: this.snapshot.sessionId,
      snapshotId: this.snapshot.snapshotId,
      entryId: this.snapshot.entryId,
      messageHash: this.snapshot.messageHash,
      pid: process.pid,
      transport: "unix",
      socketPath: this.socketPath,
      token: this.token,
      startedAt: new Date().toISOString(),
    };
    this.manifestFile = await publishManifest(this.reservation, manifest);
    this.reservation = undefined;
    this.manifest = manifest;
    this.state = "running";
    return manifest;
  }

  async updateSnapshot(snapshot: MessageSnapshot): Promise<BridgeManifest> {
    if (this.state !== "running" || !this.manifest || !this.manifestFile) throw new Error("Nvimotator bridge is not running.");
    this.snapshot = snapshot;
    this.submissions.replaceSnapshot(snapshot);
    this.manifest = {
      ...this.manifest,
      sessionId: snapshot.sessionId,
      snapshotId: snapshot.snapshotId,
      entryId: snapshot.entryId,
      messageHash: snapshot.messageHash,
    };
    await updateManifest(this.manifestFile, this.token, this.manifest);
    return this.manifest;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" && !this.manifestFile && !this.reservation) return;
    if (this.state === "stopping" && this.stopPromise) return this.stopPromise;
    const starting = this.startPromise;
    this.state = "stopping";
    this.stopPromise = (async () => {
      let cleanupError: unknown;
      try {
        await starting?.catch(() => undefined);
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await this.closeServer();
        await removeSocket(this.socketPath, this.socketIdentity);
        await removeManifest(this.manifestFile, { token: this.token, instanceId: this.instanceId });
        if (this.reservation) await releaseReservation(this.reservation).catch(() => undefined);
      } catch (error) {
        cleanupError = error;
      } finally {
        this.manifestFile = undefined;
        this.reservation = undefined;
        this.socketPath = undefined;
        this.socketIdentity = undefined;
        this.manifest = undefined;
        this.state = "stopped";
        try { this.options.onClosed?.(); } catch { /* extension callbacks must not break cleanup */ }
      }
      if (cleanupError !== undefined) throw cleanupError;
    })();
    return this.stopPromise;
  }

  private accept(socket: Socket): void {
    if (this.state !== "running" || this.sockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
    const lifetime = setTimeout(() => socket.destroy(), CONNECTION_TIMEOUT_MS);
    lifetime.unref();
    socket.once("close", () => {
      clearTimeout(lifetime);
      this.sockets.delete(socket);
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        overflow = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      if (overflow || socket.destroyed) return;
      void this.handleFrame(Buffer.concat(chunks)).then(({ response, finish }) => {
        const encoded = `${JSON.stringify(response)}\n`;
        if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
          socket.end(`${JSON.stringify(errorResponse("internal_error", "Bridge response is too large", false, response.requestId))}\n`);
          return;
        }
        socket.end(encoded, () => {
          if (finish) setImmediate(() => { void this.stop().catch(() => undefined); });
        });
      }).catch(() => socket.destroy());
    });
    socket.once("error", () => socket.destroy());
  }

  private async handleFrame(frame: Buffer): Promise<{ response: BridgeResponse; finish: boolean }> {
    const newline = frame.indexOf(0x0a);
    if (newline < 0 || frame.subarray(newline + 1).toString("utf8").trim()) {
      return { response: errorResponse("invalid_request", "Request must contain one newline-terminated JSON object", false), finish: false };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, newline));
    } catch {
      return { response: errorResponse("invalid_utf8", "Request is not valid UTF-8", false), finish: false };
    }
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch { return { response: errorResponse("invalid_json", "Request is not valid JSON", false), finish: false }; }
    const parsed = parseRequest(raw);
    if (!parsed.ok) return { response: parsed.response, finish: false };
    return this.dispatch(parsed.request);
  }

  private dispatch(request: BridgeRequest): { response: BridgeResponse; finish: boolean } {
    if (!tokensMatch(request.token, this.token)) {
      return { response: errorResponse("authentication_failed", "Authentication failed", false, request.requestId), finish: false };
    }
    if (!this.manifest || request.bridgeId !== this.manifest.bridgeId || request.instanceId !== this.instanceId || request.sessionId !== this.snapshot.sessionId) {
      return { response: errorResponse("stale_session", "Bridge session identity does not match", false, request.requestId), finish: false };
    }
    if (request.snapshotId !== this.snapshot.snapshotId) {
      return { response: errorResponse("stale_snapshot", "The assistant snapshot has changed; attach again", false, request.requestId), finish: false };
    }
    if (this.state !== "running") {
      return { response: errorResponse("bridge_stopping", "Bridge is shutting down", true, request.requestId), finish: false };
    }
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      ok: true as const,
      requestId: request.requestId,
      bridgeId: this.manifest.bridgeId,
      instanceId: this.instanceId,
      sessionId: this.snapshot.sessionId,
      snapshotId: this.snapshot.snapshotId,
    };
    try {
      if (request.type === "ping") return { response: { ...base, type: "pong" }, finish: false };
      if (request.type === "snapshot") {
        return {
          response: {
            ...base,
            type: "snapshot",
            entryId: this.snapshot.entryId,
            messageHash: this.snapshot.messageHash,
            text: this.snapshot.text,
            quickActions: QUICK_ACTIONS,
            kind: this.snapshot.kind ?? "message",
            ...(this.snapshot.kind === "file" && this.snapshot.filePath ? { filePath: this.snapshot.filePath } : {}),
          },
          finish: false,
        };
      }
      if (request.type === "render") {
        const prompt = this.submissions.render(request.submissionId, request.annotations);
        return { response: { ...base, type: "rendered", submissionId: request.submissionId, annotationCount: request.annotations.length, prompt }, finish: false };
      }
      if (request.type === "submit") {
        this.submissions.schedule(request.submissionId, request.annotations, this.options.onSubmit);
        return { response: { ...base, type: "submitted", submissionId: request.submissionId, annotationCount: request.annotations.length, status: "scheduled" }, finish: false };
      }
      if (!this.submissions.isScheduled(request.submissionId)) {
        return { response: errorResponse("invalid_request", "Submission was not scheduled by this bridge", false, request.requestId), finish: false };
      }
      return { response: { ...base, type: "finished", submissionId: request.submissionId }, finish: true };
    } catch (error) {
      const deterministic = error instanceof SubmissionError || error instanceof FeedbackError;
      const message = error instanceof Error ? error.message : String(error);
      return {
        response: errorResponse(deterministic ? "invalid_request" : "internal_error", message, !deterministic, request.requestId),
        finish: false,
      };
    }
  }

  private async closeServer(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
