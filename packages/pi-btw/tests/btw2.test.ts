import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantText,
  BTW2_WIDGET_KEY,
  BTW2_WIDGET_MAX_LINES,
  buildBtw2WidgetLines,
  buildForkNoticeLines,
  defaultForkName,
  hasOpaqueProviderCheckpoint,
  messageText,
  oneLine,
  parseBtw2Command,
  prepareOpaqueProviderReplay,
  serializeBtw2Transcript,
  validatePromotableMessages,
} from "../btw2.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

const MODEL = {
  id: "gpt-5.5",
  name: "Test model",
  api: "openai-responses",
  provider: "fluxion-gpt",
  baseUrl: "https://fluxionai.space/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
} as Model<any>;

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function user(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistant(
  content: AssistantMessage["content"] = [{ type: "text", text: "answer" }],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: ZERO_USAGE,
    stopReason,
    timestamp: 2,
  };
}

function toolResult(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

/** Build a session entry with a unique id and a chainable parentId. */
function entry<T extends Omit<SessionEntry, "id" | "parentId" | "timestamp">>(
  id: string,
  parentId: string | null,
  fields: T,
): SessionEntry {
  return {
    id,
    parentId,
    timestamp: new Date(1).toISOString(),
    ...fields,
  } as SessionEntry;
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
  return entry(id, parentId, { type: "message", message } as never);
}

const SHIM = "[OpenAI native compaction checkpoint]";

test("parseBtw2Command recognizes browsing and every exact action", () => {
  const cases: Array<[string, ReturnType<typeof parseBtw2Command>]> = [
    ["", { kind: "browse" }],
    [" \n\t ", { kind: "browse" }],
    ["  --discard  ", { kind: "discard" }],
    ["--stop", { kind: "stop" }],
    ["\n--dismiss\t", { kind: "dismiss" }],
    ["--help", { kind: "help" }],
    [" -h ", { kind: "help" }],
    ["--fork", { kind: "fork" }],
    [" --fork   ", { kind: "fork" }],
  ];

  for (const [raw, expected] of cases) {
    assert.deepEqual(parseBtw2Command(raw), expected, raw);
  }
});

test("parseBtw2Command parses a trimmed fork name", () => {
  assert.deepEqual(parseBtw2Command("--fork release review"), {
    kind: "fork",
    name: "release review",
  });
  assert.deepEqual(parseBtw2Command("  --fork     spaced name   "), {
    kind: "fork",
    name: "spaced name",
  });
});

test("parseBtw2Command treats ordinary and unrecognized input as a trimmed prompt", () => {
  assert.deepEqual(parseBtw2Command("  explain this\ncarefully  "), {
    kind: "send",
    text: "explain this\ncarefully",
  });
  assert.deepEqual(parseBtw2Command("--stop now"), { kind: "send", text: "--stop now" });
  assert.deepEqual(parseBtw2Command("--fork\tname"), {
    kind: "send",
    text: "--fork\tname",
  });
});

test("oneLine compacts whitespace and truncates at exact boundaries", () => {
  assert.equal(oneLine("  alpha\t beta\n gamma\r\n  "), "alpha beta gamma");
  assert.equal(oneLine("x".repeat(96)), "x".repeat(96));
  assert.equal(oneLine("x".repeat(97)), `${"x".repeat(95)}…`);
  assert.equal(oneLine("abcdef", 5), "abcd…");
  assert.equal(oneLine("  \n\t  "), "");
});

test("assistantText returns only concatenated assistant text blocks", () => {
  const message = assistant([
    { type: "thinking", thinking: "private reasoning" },
    { type: "text", text: "first" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
    { type: "text", text: " + second" },
  ]);

  assert.equal(assistantText(message), "first + second");
  assert.equal(assistantText(user("not an assistant")), "");
  assert.equal(assistantText(undefined), "");
});

test("messageText handles both user content forms and non-conversation roles", () => {
  assert.equal(messageText(user("plain user text")), "plain user text");
  assert.equal(
    messageText(
      user([
        { type: "text", text: "first line" },
        { type: "image", data: "base64", mimeType: "image/png" },
        { type: "text", text: "second line" },
      ]),
    ),
    "first line\nsecond line",
  );
  assert.equal(messageText(assistant([{ type: "text", text: "assistant text" }])), "assistant text");
  assert.equal(messageText(toolResult("tool output")), "");
});

test("serializeBtw2Transcript formats visible user and assistant text only", () => {
  const messages: AgentMessage[] = [
    user("  first question  "),
    toolResult("must not appear"),
    assistant([
      { type: "thinking", thinking: "must not appear" },
      { type: "text", text: "first" },
      { type: "text", text: " answer" },
    ]),
    user([{ type: "image", data: "base64", mimeType: "image/png" }]),
    assistant([{ type: "thinking", thinking: "thinking only" }]),
    user([
      { type: "text", text: "line one" },
      { type: "image", data: "base64", mimeType: "image/jpeg" },
      { type: "text", text: "line two" },
    ]),
    assistant([{ type: "text", text: "  done  " }]),
  ];

  assert.equal(
    serializeBtw2Transcript(messages),
    [
      "# BTW2 transcript",
      "",
      "## User",
      "",
      "first question",
      "",
      "## Assistant",
      "",
      "first answer",
      "",
      "## User",
      "",
      "line one",
      "line two",
      "",
      "## Assistant",
      "",
      "done",
    ].join("\n"),
  );
  assert.equal(serializeBtw2Transcript([]), "# BTW2 transcript");
  assert.equal(serializeBtw2Transcript([user("  "), assistant([])]), "# BTW2 transcript");
});

test("buildBtw2WidgetLines renders identity, ready state, turn grammar, and help", () => {
  assert.equal(BTW2_WIDGET_KEY, "pi-btw");
  assert.equal(BTW2_WIDGET_MAX_LINES, 9);
  assert.deepEqual(
    buildBtw2WidgetLines({
      modelLabel: "openai/test-model",
      thinkingLevel: "high",
      status: "idle",
      completedTurns: 1,
    }),
    [
      "BTW2 · openai/test-model · thinking high · no tools",
      "ready · 1 completed turn",
      "/btw2 <follow-up> · /btw2 actions · /btw2 --fork · /tools",
    ],
  );
});

test("buildBtw2WidgetLines shows with tools when the branch tool set is enabled", () => {
  assert.deepEqual(
    buildBtw2WidgetLines({
      modelLabel: "openai/test-model",
      thinkingLevel: "max",
      status: "running",
      completedTurns: 3,
      toolsEnabled: true,
    })[0],
    "BTW2 · openai/test-model · thinking max · with tools",
  );
  assert.deepEqual(
    buildBtw2WidgetLines({
      modelLabel: "openai/test-model",
      thinkingLevel: "max",
      status: "running",
      completedTurns: 3,
      toolsEnabled: false,
    })[0],
    "BTW2 · openai/test-model · thinking max · no tools",
  );
});

test("buildBtw2WidgetLines maps every runtime status", () => {
  const expected = {
    idle: "ready",
    running: "answering",
    stopping: "stopping",
    forking: "forking",
    error: "error",
  } as const;

  for (const [status, label] of Object.entries(expected)) {
    const lines = buildBtw2WidgetLines({
      modelLabel: "provider/model",
      thinkingLevel: "off",
      status: status as keyof typeof expected,
      completedTurns: 2,
    });
    assert.equal(lines[1], `${label} · 2 completed turns`);
  }
});

test("buildBtw2WidgetLines bounds and compacts question, recent answers, and error", () => {
  const longAnswer = "x".repeat(101);
  const lines = buildBtw2WidgetLines({
    modelLabel: "provider/model",
    thinkingLevel: "max",
    status: "error",
    completedTurns: 12,
    lastQuestion: "  why\n now?  ",
    answerText: `old one\nold two\n\n recent three\r\n${longAnswer}\n recent five `,
    errorMessage: "  provider\n failed  ",
  });

  assert.ok(lines.length <= BTW2_WIDGET_MAX_LINES);
  assert.deepEqual(lines, [
    "BTW2 · provider/model · thinking max · no tools",
    "error · 12 completed turns",
    "Q  why now?",
    "A  recent three",
    `A  ${"x".repeat(99)}…`,
    "A  recent five",
    "!  provider failed",
    "/btw2 <follow-up> · /btw2 actions · /btw2 --fork · /tools",
  ]);
  assert.equal(lines.filter((line) => line.startsWith("A  ")).length, 3);
});

test("buildForkNoticeLines returns complete detached-resume instructions", () => {
  assert.deepEqual(
    buildForkNoticeLines({
      sessionId: "session-123",
      sessionPath: "/tmp/sessions/session 123.jsonl",
    }),
    [
      "BTW2 fork ready · session-123",
      "Resume: pi --session session-123",
      "Path: /tmp/sessions/session 123.jsonl",
      "Parent stays active; concurrent writes to the same workspace can conflict.",
      "/btw2 --dismiss to clear this notice",
    ],
  );
});

test("defaultForkName uses the first user text, normalized and bounded", () => {
  assert.equal(
    defaultForkName([
      assistant([{ type: "text", text: "preface" }]),
      user([
        { type: "text", text: "  investigate" },
        { type: "image", data: "base64", mimeType: "image/png" },
        { type: "text", text: "this   failure  " },
      ]),
      user("later question"),
    ]),
    "BTW2: investigate this failure",
  );
  assert.equal(defaultForkName([user("x".repeat(60))]), `BTW2: ${"x".repeat(47)}…`);
});

test("defaultForkName falls back when no usable first user text exists", () => {
  assert.equal(defaultForkName([]), "BTW2: side conversation");
  assert.equal(defaultForkName([assistant(), toolResult("output")]), "BTW2: side conversation");
  assert.equal(defaultForkName([user("")]), "BTW2: side conversation");
  assert.equal(
    defaultForkName([user([{ type: "image", data: "base64", mimeType: "image/png" }])]),
    "BTW2: side conversation",
  );
});

test("validatePromotableMessages accepts one or more complete no-tool turns", () => {
  assert.doesNotThrow(() =>
    validatePromotableMessages([
      user("first"),
      assistant([
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer one" },
      ]),
      user("second"),
      assistant([{ type: "text", text: "answer two" }], "length"),
    ]),
  );
});

test("validatePromotableMessages rejects empty and incomplete transcripts", () => {
  assert.throws(
    () => validatePromotableMessages([]),
    /BTW2 has no completed turns to fork/,
  );
  assert.throws(
    () => validatePromotableMessages([user("question")]),
    /BTW2 transcript is incomplete/,
  );
  assert.throws(
    () => validatePromotableMessages([user("one"), assistant(), user("two")]),
    /BTW2 transcript is incomplete/,
  );
});

test("validatePromotableMessages enforces user/assistant alternation for every turn", () => {
  assert.throws(
    () => validatePromotableMessages([assistant(), user("question")]),
    /BTW2 transcript must alternate user and assistant messages/,
  );
  assert.throws(
    () => validatePromotableMessages([user("one"), assistant(), user("two"), user("three")]),
    /BTW2 transcript must alternate user and assistant messages/,
  );
  assert.throws(
    () => validatePromotableMessages([user("question"), toolResult("output")]),
    /BTW2 transcript must alternate user and assistant messages/,
  );
});

test("validatePromotableMessages rejects errored and aborted assistant responses", () => {
  for (const reason of ["error", "aborted"] as const) {
    assert.throws(
      () => validatePromotableMessages([user("question"), assistant([], reason)]),
      /BTW2 transcript contains an incomplete assistant response/,
      reason,
    );
  }
});

test("validatePromotableMessages accepts tool-bearing turns when tools are enabled", () => {
  const withTools = (): AgentMessage[] => [
    user("inspect the file"),
    assistant([
      { type: "text", text: "I will read it." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
    ]),
    toolResult("file contents"),
    assistant([{ type: "text", text: "here is the answer" }]),
    user("now fix it"),
    assistant([
      { type: "toolCall", id: "call-2", name: "edit", arguments: { path: "a.txt" } },
    ]),
    toolResult("edited"),
    assistant([{ type: "text", text: "done" }]),
  ];

  assert.doesNotThrow(() => validatePromotableMessages(withTools(), true));
  // The same transcript is invalid under the no-tool contract.
  assert.throws(
    () => validatePromotableMessages(withTools()),
    /unexpectedly contains a tool call|unexpected tool result/,
  );
});

test("validatePromotableMessages rejects broken tool transcripts", () => {
  const toolCallAssistant = assistant([
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
  ]);
  const toolResultMessage = toolResult("output");

  assert.throws(
    () => validatePromotableMessages([user("q"), toolCallAssistant, assistant()], true),
    /unresolved tool call/,
  );
  assert.throws(
    () => validatePromotableMessages([user("q"), toolResultMessage], true),
    /must alternate user and assistant messages/,
  );
  assert.throws(
    () => validatePromotableMessages([user("q"), toolCallAssistant, toolResultMessage, toolCallAssistant], true),
    /ends with an unresolved tool call/,
  );
  assert.throws(
    () => validatePromotableMessages([user("q"), assistant(), user("r"), assistant([], "aborted")], true),
    /incomplete assistant response/,
  );
});

test("validatePromotableMessages rejects a tool call in any completed turn", () => {
  const withToolCall = assistant([
    { type: "text", text: "I will inspect it." },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.txt" } },
  ]);

  assert.throws(
    () =>
      validatePromotableMessages([
        user("safe first turn"),
        assistant(),
        user("inspect a file"),
        withToolCall,
      ]),
    /BTW2 no-tool transcript unexpectedly contains a tool call/,
  );
});

test("hasOpaqueProviderCheckpoint detects only opaque native compaction entries", () => {
  assert.equal(hasOpaqueProviderCheckpoint([]), false);
  assert.equal(hasOpaqueProviderCheckpoint([
    { type: "compaction", summary: "readable summary", details: { strategy: "other" } },
  ]), false);
  assert.equal(hasOpaqueProviderCheckpoint([
    { type: "compaction", summary: "[OpenAI native compaction checkpoint]" },
  ]), true);
  assert.equal(hasOpaqueProviderCheckpoint([
    { type: "compaction", summary: "changed shim", details: { strategy: "openai-responses-compaction-v2" } },
  ]), true);
  assert.equal(hasOpaqueProviderCheckpoint([
    { type: "custom", summary: "[OpenAI native compaction checkpoint]" },
  ]), false);
});

test("prepareOpaqueProviderReplay removes the shim window and prepends native history", () => {
  const retainedUser = user("retained user");
  const retainedAssistant = assistant([{ type: "text", text: "retained assistant" }]);
  const tailUser = user("after checkpoint");
  const tailAssistant = assistant([{ type: "text", text: "tail answer" }]);
  const replacementHistory = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retained user" }] },
    { type: "compaction", encrypted_content: "opaque-checkpoint" },
  ];
  const branch: SessionEntry[] = [
    messageEntry("retained-user", null, retainedUser),
    messageEntry("retained-assistant", "retained-user", retainedAssistant),
    entry("checkpoint", "retained-assistant", {
      type: "compaction",
      summary: SHIM,
      firstKeptEntryId: "retained-user",
      tokensBefore: 50_000,
      fromHook: true,
      details: {
        strategy: "openai-responses-compaction-v2",
        adapter: "standard-responses-json",
        provider: MODEL.provider,
        api: MODEL.api,
        model: MODEL.id,
        baseUrl: MODEL.baseUrl,
        replacementHistory,
        createdAt: new Date(1).toISOString(),
      },
    }),
    messageEntry("tail-user", "checkpoint", tailUser),
    messageEntry("tail-assistant", "tail-user", tailAssistant),
  ];

  const replay = prepareOpaqueProviderReplay(branch, "tail-assistant", MODEL);
  assert.ok(replay);
  assert.deepEqual(replay.messages, [tailUser, tailAssistant]);

  const payload = {
    model: MODEL.id,
    input: [
      { role: "developer", content: "frozen system prompt" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new side question" }] },
    ],
    messages: ["legacy"],
    previous_response_id: "must-not-chain",
  };
  const rewritten = replay.rewritePayload(payload, MODEL) as Record<string, unknown>;
  assert.deepEqual(rewritten.input, [
    ...replacementHistory,
    payload.input[1],
  ]);
  assert.equal("messages" in rewritten, false);
  assert.equal("previous_response_id" in rewritten, false);
  assert.deepEqual(payload.input, [
    { role: "developer", content: "frozen system prompt" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "new side question" }] },
  ]);
});

test("prepareOpaqueProviderReplay returns undefined without a marked checkpoint", () => {
  const branch: SessionEntry[] = [
    messageEntry("user-1", null, user("question")),
    messageEntry("assistant-1", "user-1", assistant()),
  ];
  assert.equal(prepareOpaqueProviderReplay(branch, "assistant-1", MODEL), undefined);
  assert.equal(
    prepareOpaqueProviderReplay([
      messageEntry("user-1", null, user("question")),
      entry("readable", "user-1", {
        type: "compaction",
        summary: "readable summary",
        firstKeptEntryId: "user-1",
        tokensBefore: 10_000,
      }),
    ], "readable", MODEL),
    undefined,
  );
});

test("prepareOpaqueProviderReplay rejects provider identity drift and malformed details", () => {
  const branch: SessionEntry[] = [
    messageEntry("retained-user", null, user("retained")),
    entry("checkpoint", "retained-user", {
      type: "compaction",
      summary: SHIM,
      firstKeptEntryId: "retained-user",
      tokensBefore: 50_000,
      details: {
        strategy: "openai-responses-compaction-v2",
        adapter: "standard-responses-json",
        provider: MODEL.provider,
        api: MODEL.api,
        model: MODEL.id,
        baseUrl: MODEL.baseUrl,
        replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
        createdAt: new Date(1).toISOString(),
      },
    }),
  ];

  assert.throws(
    () => prepareOpaqueProviderReplay(branch, "checkpoint", { ...MODEL, id: "other-model" }),
    /selected provider endpoint or model/,
  );
  assert.throws(
    () => prepareOpaqueProviderReplay(
      [
        messageEntry("retained-user", null, user("retained")),
        entry("checkpoint", "retained-user", {
          type: "compaction",
          summary: SHIM,
          firstKeptEntryId: "retained-user",
          tokensBefore: 50_000,
          details: { strategy: "openai-responses-compaction-v2" },
        }),
      ],
      "checkpoint",
      MODEL,
    ),
    /malformed opaque OpenAI server-compaction checkpoint/,
  );
});

test("prepareOpaqueProviderReplay rejects a missing or off-path boundary", () => {
  const details = {
    strategy: "openai-responses-compaction-v2",
    adapter: "standard-responses-json",
    provider: MODEL.provider,
    api: MODEL.api,
    model: MODEL.id,
    baseUrl: MODEL.baseUrl,
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
    createdAt: new Date(1).toISOString(),
  };
  assert.throws(
    () => prepareOpaqueProviderReplay(
      [
        messageEntry("retained-user", null, user("retained")),
        entry("checkpoint", "retained-user", {
          type: "compaction",
          summary: SHIM,
          firstKeptEntryId: "missing-entry",
          tokensBefore: 50_000,
          details,
        }),
      ],
      "checkpoint",
      MODEL,
    ),
    /retained-message boundary is invalid/,
  );
  assert.throws(
    () => prepareOpaqueProviderReplay(
      [
        messageEntry("user-1", null, user("question")),
        messageEntry("assistant-1", "user-1", assistant()),
        entry("off-path", "assistant-1", {
          type: "compaction",
          summary: SHIM,
          firstKeptEntryId: "user-1",
          tokensBefore: 50_000,
          details,
        }),
      ],
      "assistant-1",
      MODEL,
    ),
    /could not locate the opaque checkpoint boundary/,
  );
});

test("prepareOpaqueProviderReplay supports same-endpoint Codex model changes", () => {
  const codexModel = {
    ...MODEL,
    id: "gpt-5.6-sol",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
  } as Model<any>;
  const branch: SessionEntry[] = [
    messageEntry("retained-user", null, user("retained")),
    entry("checkpoint", "retained-user", {
      type: "compaction",
      id: "checkpoint",
      parentId: "retained-user",
      timestamp: new Date(1).toISOString(),
      summary: SHIM,
      firstKeptEntryId: "retained-user",
      tokensBefore: 50_000,
      details: {
        strategy: "openai-responses-compaction-v2",
        adapter: "codex-trigger-sse",
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.5",
        baseUrl: "https://chatgpt.com/backend-api",
        replacementHistory: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
          { type: "compaction", encrypted_content: "opaque" },
        ],
        createdAt: new Date(1).toISOString(),
      },
    }),
    messageEntry("tail-user", "checkpoint", user("tail")),
  ];
  const replay = prepareOpaqueProviderReplay(branch, "tail-user", codexModel);
  assert.ok(replay);
  assert.deepEqual(replay.messages, [user("tail")]);
  assert.deepEqual(
    replay.rewritePayload(
      {
        model: codexModel.id,
        instructions: "frozen prompt",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "tail" }] }],
      },
      codexModel,
    ),
    {
      model: codexModel.id,
      instructions: "frozen prompt",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
        { type: "compaction", encrypted_content: "opaque" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "tail" }] },
      ],
    },
  );
});
