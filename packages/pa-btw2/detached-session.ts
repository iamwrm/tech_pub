import { linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier } from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { defaultForkName, validatePromotableMessages } from "./btw2.ts";

export interface DetachedForkRequest {
  sourceSessionFile: string;
  sourceSessionDir: string;
  sourceSessionId: string;
  sourceSessionCwd: string;
  sourceLeafId: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  serviceTier: ServiceTier;
  messages: readonly AgentMessage[];
  name?: string;
}

export interface DetachedForkResult {
  sessionId: string;
  sessionPath: string;
  parentSessionPath: string;
  cwd: string;
}

function appendPromotedMessage(target: SessionManager, message: AgentMessage): void {
  if (message.role !== "user" && message.role !== "assistant") {
    throw new Error(`Unsupported BTW2 message role: ${String((message as { role?: unknown }).role)}`);
  }
  target.appendMessage(
    structuredClone(message) as Parameters<SessionManager["appendMessage"]>[0],
  );
}

function assertSafeSourceFile(request: DetachedForkRequest): void {
  const content = readFileSync(request.sourceSessionFile, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("BTW2 parent session file is empty");

  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("BTW2 parent session contains malformed JSONL");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("BTW2 parent session contains an invalid entry");
    }
    entries.push(value as Record<string, unknown>);
  }

  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") {
    throw new Error("BTW2 parent session is missing a valid header");
  }
  if (header.version !== CURRENT_SESSION_VERSION) {
    throw new Error(
      `BTW2 detached fork requires current session format v${CURRENT_SESSION_VERSION}`,
    );
  }
  if (header.id !== request.sourceSessionId) {
    throw new Error("BTW2 parent session changed before fork materialization");
  }
  if (!entries.some((entry) => entry.id === request.sourceLeafId)) {
    throw new Error("BTW2 fork anchor is not present in the persisted parent session");
  }
}

/**
 * Materialize a sleeping, detached normal session without replacing the
 * currently active Prime Agent runtime.
 *
 * SessionManager.createBranchedSession() mutates the manager it is called on,
 * so this function always opens a separate manager for the source file. The
 * live worker-owned SessionManager is never mutated.
 */
export function materializeDetachedFork(request: DetachedForkRequest): DetachedForkResult {
  validatePromotableMessages(request.messages);
  if (!request.sourceSessionFile) throw new Error("BTW2 requires a persisted parent session");
  if (!request.sourceLeafId) throw new Error("BTW2 cannot fork before the parent session has an entry");
  // SessionManager.open() migrates old files and repairs corrupt ones in place.
  // Reject those inputs before opening so detached materialization can never
  // mutate the live parent as a side effect of validation.
  assertSafeSourceFile(request);

  // Build outside the catalog-visible session directory and publish with one
  // same-filesystem rename. A second terminal can therefore never discover a
  // partially appended BTW2 transcript.
  const stagingDir = mkdtempSync(join(request.sourceSessionDir, ".pa-btw2-"));
  let target: SessionManager | undefined;
  let stagedPath: string | undefined;
  let publishedPath: string | undefined;
  let publishedByUs = false;
  try {
    // Preserve the live manager's effective cwd. Prime Agent can resume a
    // session with a cwd override that intentionally differs from its stored
    // header, and detached branches must inherit the effective workspace.
    target = SessionManager.open(
      request.sourceSessionFile,
      stagingDir,
      request.sourceSessionCwd,
    );
    if (target.getSessionId() !== request.sourceSessionId) {
      throw new Error("BTW2 parent session changed before fork materialization");
    }
    if (target.getCwd() !== request.sourceSessionCwd) {
      throw new Error("BTW2 parent working directory changed before fork materialization");
    }
    if (!target.getEntry(request.sourceLeafId)) {
      throw new Error("BTW2 fork anchor is not present in the persisted parent session");
    }

    stagedPath = target.createBranchedSession(request.sourceLeafId);
    if (!stagedPath) throw new Error("BTW2 parent session is not persisted");

    // Explicit configuration entries make cold resume use exactly the model,
    // thinking level, and service tier that generated the BTW2 transcript.
    target.appendModelChange(request.model.provider, request.model.id);
    target.appendThinkingLevelChange(request.thinkingLevel);
    target.appendServiceTierChange(request.serviceTier);

    for (const message of request.messages) appendPromotedMessage(target, message);
    target.appendSessionInfo(request.name?.trim() || defaultForkName(request.messages));

    // createBranchedSession copies the source path, which can include the
    // daemon-resident parent's latest "active" marker. Override it so the new
    // file remains a sleeping resume target until another terminal opens it.
    target.appendSessionState({ status: "archived" });
    target.flushNow();

    publishedPath = join(request.sourceSessionDir, basename(stagedPath));
    // A same-filesystem hard link publishes the fully flushed file in one
    // namespace operation and, unlike POSIX rename, fails with EEXIST rather
    // than clobbering an independently created session at the destination.
    linkSync(stagedPath, publishedPath);
    publishedByUs = true;
    unlinkSync(stagedPath);
    rmSync(stagingDir, { recursive: true, force: true });

    return {
      sessionId: target.getSessionId(),
      sessionPath: publishedPath,
      parentSessionPath: request.sourceSessionFile,
      cwd: target.getCwd(),
    };
  } catch (error) {
    // The paths are unique and owned by this operation. Never advertise or
    // leave a partially materialized resume target after a failed append,
    // flush, or atomic publication.
    if (publishedByUs && publishedPath) {
      try {
        rmSync(publishedPath, { force: true });
      } catch {
        // Preserve the original materialization error.
      }
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Preserve the original materialization error.
    }
    throw error;
  }
}
