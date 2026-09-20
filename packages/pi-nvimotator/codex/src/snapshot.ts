import { snapshotFromAssistantText, type MessageSnapshot } from "../../src/assistant-message.ts";
import { captureLatestCodexMessage, type DiscoveryPaths } from "./codex-session.ts";

export function snapshotCodexLastMessage(opts: DiscoveryPaths = {}): MessageSnapshot {
  const latest = captureLatestCodexMessage(opts);
  return snapshotFromAssistantText(latest.sessionId, latest.messageId, latest.text);
}
