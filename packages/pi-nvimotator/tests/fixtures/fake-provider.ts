import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";

const artifactDirectory = process.env.NVIMOTATOR_E2E_ARTIFACTS!;
const fixturePath = process.env.NVIMOTATOR_E2E_ASSISTANT!;
let callCount = 0;

function userText(context: Context): string {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "nvimotator-e2e" as any,
    provider: "nvimotator-e2e",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export default function fakeProvider(pi: ExtensionAPI): void {
  mkdirSync(artifactDirectory, { recursive: true });
  pi.registerProvider("nvimotator-e2e", {
    baseUrl: "http://127.0.0.1/never-used",
    apiKey: "NVIMOTATOR_E2E_KEY",
    api: "nvimotator-e2e" as any,
    models: [{
      id: "fixture",
      name: "Nvimotator E2E Fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 4_096,
    }],
    streamSimple: (_model, context) => {
      callCount += 1;
      const current = callCount;
      writeFileSync(join(artifactDirectory, `request-${current}.bin`), userText(context));
      writeFileSync(join(artifactDirectory, "call-count"), `${current}\n`);
      const text = current === 1 ? readFileSync(fixturePath, "utf8") : "NVIMOTATOR_E2E_ACK";
      const message = response(text);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = { ...message, content: [{ type: "text" as const, text: "" }], stopReason: "pending" as const };
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        const complete = { ...partial, content: [{ type: "text" as const, text }] };
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: complete });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: complete });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        writeFileSync(join(artifactDirectory, `response-${current}.ready`), "ready\n");
      });
      return stream;
    },
  });
  writeFileSync(join(artifactDirectory, "startup.ready"), "ready\n");
}
