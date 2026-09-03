import { snapshotFromAssistantText, type MessageSnapshot } from "../../src/assistant-message.ts";
import { captureLatestClaudeMessage, type DiscoveryPaths } from "./claude-session.ts";

export function snapshotClaudeLastMessage(opts: DiscoveryPaths & { logPath?: string } = {}): MessageSnapshot {
  const latest = captureLatestClaudeMessage(opts);
  return snapshotFromAssistantText(latest.sessionId, latest.messageId, latest.text);
}
