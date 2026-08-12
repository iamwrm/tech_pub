/**
 * pi-btw — portable no-tool side branches for pi.
 *
 * `/btw2 <question>` forks the current effective conversation into an in-memory
 * Agent with the same model, thinking level, and system prompt, but an empty
 * tool list. Bare `/btw2` opens the multi-line question editor until a branch
 * exists; Esc returns without creating branch state. Follow-ups use the same
 * command. Nothing is written to the parent session until the user explicitly
 * materializes the side branch.
 *
 * `/btw2 --fork [name]` writes a detached, sleeping normal session and returns
 * its persistent session id. The current terminal remains on the parent; open
 * the new branch with `pi --session <session-id>` to regain normal tools and
 * write access.
 */
import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { streamSimple, type Model } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  assistantText,
  BTW2_WIDGET_KEY,
  buildBtw2WidgetLines,
  buildForkNoticeLines,
  defaultForkName,
  parseBtw2Command,
  prepareOpaqueProviderReplay,
  serializeBtw2Transcript,
  type Btw2ForkNotice,
  type Btw2RunStatus,
} from "./btw2.ts";
import {
  materializeDetachedFork,
  type DetachedForkRequest,
  type DetachedForkResult,
} from "./detached-session.ts";
import { CORE_TOOL_NAMES, createCoreAgentTools } from "./side-tools.ts";

const SIDE_SYSTEM_NOTE = `

---
## BTW2 no-tool side branch

You are in a private side branch forked from the main conversation. Use the
same reasoning quality as the parent, but you have no tools and cannot read,
write, execute, browse, or otherwise inspect anything beyond the conversation
context already provided. Do not claim that you used a tool. If action is
needed, explain what should be done; the user can materialize this branch as a
normal session and resume it with tools later.`;

const SIDE_TOOLS_SYSTEM_NOTE = `

---
## BTW2 side branch with tools

You are in a private side branch forked from the main conversation. You have
the normal core tools (${CORE_TOOL_NAMES.join(", ")}) and share the parent's
workspace. Tool side effects are real and can conflict with the main session;
be careful with mutating commands. The user can materialize this branch as a
normal session with /btw2 --fork.`;

const WIDGET_RENDER_INTERVAL_MS = 120;

export interface Btw2AgentSnapshot {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  messages: AgentMessage[];
  sessionId: string;
  modelRegistry: ExtensionCommandContext["modelRegistry"];
  rewriteProviderPayload?: (payload: unknown, requestModel: Model<any>) => unknown;
  /** Side-branch tool set; empty (default) keeps the no-tool contract. */
  tools?: AgentTool[];
}

export interface Btw2Dependencies {
  createAgent(snapshot: Btw2AgentSnapshot): Agent;
  materializeFork(request: DetachedForkRequest): DetachedForkResult;
  createRunId(): string;
  now(): number;
}

interface LiveBtw2 {
  ownerSessionId: string;
  sourceSessionFile: string | undefined;
  sourceSessionDir: string;
  sourceSessionCwd: string;
  sourceLeafId: string | null;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  modelRegistry: ExtensionCommandContext["modelRegistry"];
  rewriteProviderPayload?: (payload: unknown, requestModel: Model<any>) => unknown;
  agentSessionId: string;
  agent: Agent;
  tools: AgentTool[];
  promotableMessages: AgentMessage[];
  status: Btw2RunStatus;
  completedTurns: number;
  lastQuestion?: string;
  answerText: string;
  errorMessage?: string;
  runPromise?: Promise<void>;
  materializing: boolean;
  disposed: boolean;
  lastWidgetAt: number;
  widgetCtx: ExtensionCommandContext;
  unsubscribe: () => void;
}

function normalizeThinkingLevel(value: string, fallback: ThinkingLevel): ThinkingLevel {
  const supported = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return supported.has(value as ThinkingLevel) ? (value as ThinkingLevel) : fallback;
}

export function createBtw2Agent(snapshot: Btw2AgentSnapshot): Agent {
  const authenticatedStream: StreamFn = async (model, context, options) => {
    const auth = await snapshot.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    return streamSimple(model, context, {
      ...options,
      apiKey: auth.apiKey,
      headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
    });
  };

  const tools = snapshot.tools ?? [];
  const sideNote = tools.length > 0 ? SIDE_TOOLS_SYSTEM_NOTE : SIDE_SYSTEM_NOTE;
  return new Agent({
    initialState: {
      model: snapshot.model,
      thinkingLevel: snapshot.thinkingLevel,
      systemPrompt: `${snapshot.systemPrompt}${sideNote}`,
      messages: structuredClone(snapshot.messages),
      tools,
    },
    convertToLlm,
    streamFn: authenticatedStream,
    onPayload: snapshot.rewriteProviderPayload,
    sessionId: snapshot.sessionId,
    transport: "auto",
  });
}

const DEFAULT_DEPS: Btw2Dependencies = {
  createAgent: createBtw2Agent,
  materializeFork: materializeDetachedFork,
  createRunId: randomUUID,
  now: Date.now,
};

function modelLabel(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validTurnDelta(messages: readonly AgentMessage[], toolsEnabled: boolean): boolean {
  if (messages.length === 0) return false;
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first?.role !== "user" || last?.role !== "assistant") return false;
  if (last.stopReason === "error" || last.stopReason === "aborted") return false;
  if (last.content.some((part) => part.type === "toolCall")) return false;
  // Without tools each turn is exactly one user/assistant pair; with tools the
  // loop may interleave assistant tool-call messages and toolResult messages.
  return toolsEnabled || messages.length === 2;
}

export function createBtw2Extension(overrides: Partial<Btw2Dependencies> = {}) {
  const deps: Btw2Dependencies = { ...DEFAULT_DEPS, ...overrides };

  return function btw2Extension(pi: ExtensionAPI): void {
    // pi can share one extension instance across several sessions; never keep
    // a singleton side branch without a session key.
    const liveBySession = new Map<string, LiveBtw2>();
    const forkNotices = new Map<string, Btw2ForkNotice>();

    function safeWidget(ctx: ExtensionCommandContext, lines: string[] | undefined): void {
      try {
        ctx.ui.setWidget(BTW2_WIDGET_KEY, lines);
      } catch {
        // A background side request may settle after session teardown. A stale
        // UI context must never crash the runtime.
      }
    }

    function safeNotify(
      ctx: ExtensionCommandContext,
      message: string,
      type: "info" | "warning" | "error" = "info",
    ): void {
      try {
        ctx.ui.notify(message, type);
      } catch {
        // See safeWidget(): teardown wins over late background UI.
      }
    }

    function refreshWidget(state: LiveBtw2, force = false): void {
      if (state.disposed) return;
      const now = deps.now();
      if (!force && now - state.lastWidgetAt < WIDGET_RENDER_INTERVAL_MS) return;
      state.lastWidgetAt = now;
      safeWidget(
        state.widgetCtx,
        buildBtw2WidgetLines({
          modelLabel: modelLabel(state.model),
          thinkingLevel: state.thinkingLevel,
          status: state.status,
          completedTurns: state.completedTurns,
          lastQuestion: state.lastQuestion,
          answerText: state.answerText,
          errorMessage: state.errorMessage,
          toolsEnabled: state.tools.length > 0,
        }),
      );
    }

    function disposeState(sessionId: string, state: LiveBtw2, clearWidget: boolean): void {
      if (liveBySession.get(sessionId) !== state) return;
      state.disposed = true;
      state.unsubscribe();
      state.agent.abort();
      liveBySession.delete(sessionId);
      if (clearWidget) safeWidget(state.widgetCtx, undefined);
    }

    function handleAgentEvent(state: LiveBtw2, event: AgentEvent): void {
      if (state.disposed) return;
      if (event.type === "message_update" && event.message.role === "assistant") {
        state.answerText = assistantText(event.message);
        refreshWidget(state);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        state.answerText = assistantText(event.message);
        refreshWidget(state, true);
      }
    }

    function launchPrompt(state: LiveBtw2, text: string): void {
      if (state.runPromise || state.disposed) return;
      const beforeMessages = state.agent.state.messages.slice();
      state.status = "running";
      state.errorMessage = undefined;
      state.lastQuestion = text;
      state.answerText = "";
      refreshWidget(state, true);

      const run = (async () => {
        try {
          await state.agent.prompt(text);
          const delta = state.agent.state.messages.slice(beforeMessages.length);
          if (!validTurnDelta(delta, state.tools.length > 0)) {
            state.agent.state.messages = beforeMessages;
            const last = delta.findLast((message) => message.role === "assistant");
            const detail = last?.role === "assistant" ? last.errorMessage : undefined;
            throw new Error(detail || "BTW2 response was cancelled or incomplete");
          }
          state.promotableMessages.push(...structuredClone(delta));
          state.completedTurns++;
          state.answerText = assistantText(delta[1]);
          state.status = "idle";
        } catch (error) {
          state.agent.state.messages = beforeMessages;
          if (state.status === "stopping") {
            state.status = "idle";
            state.answerText = "";
            state.errorMessage = undefined;
          } else {
            state.status = "error";
            state.errorMessage = errorText(error);
          }
        } finally {
          state.runPromise = undefined;
          refreshWidget(state, true);
        }
      })();
      state.runPromise = run;
      void run.catch(() => undefined);
    }

    function createState(ctx: ExtensionCommandContext): LiveBtw2 {
      const model = ctx.model;
      if (!model) throw new Error("Select a model before starting BTW2");
      const sourceLeafId = ctx.sessionManager.getLeafId();
      const sourceSessionFile = ctx.sessionManager.getSessionFile();
      const sourceBranch = ctx.sessionManager.getBranch(sourceLeafId ?? undefined);
      const sessionContext = buildSessionContext(
        ctx.sessionManager.getEntries(),
        sourceLeafId,
      );
      const replay = prepareOpaqueProviderReplay(sourceBranch, sourceLeafId, model);
      const fallbackThinking = pi.getThinkingLevel();
      const thinkingLevel = normalizeThinkingLevel(sessionContext.thinkingLevel, fallbackThinking);
      const ownerSessionId = ctx.sessionManager.getSessionId();
      const agent = deps.createAgent({
        model,
        thinkingLevel,
        systemPrompt: ctx.getSystemPrompt(),
        messages: replay?.messages ?? sessionContext.messages,
        sessionId: deps.createRunId(),
        modelRegistry: ctx.modelRegistry,
        rewriteProviderPayload: replay?.rewritePayload,
        tools: [],
      });
      const state = {
        ownerSessionId,
        sourceSessionFile,
        sourceSessionDir: ctx.sessionManager.getSessionDir(),
        sourceSessionCwd: ctx.sessionManager.getCwd(),
        sourceLeafId,
        model,
        thinkingLevel,
        systemPrompt: ctx.getSystemPrompt(),
        modelRegistry: ctx.modelRegistry,
        rewriteProviderPayload: replay?.rewritePayload,
        agentSessionId: agent.sessionId ?? deps.createRunId(),
        agent,
        tools: [] as AgentTool[],
        promotableMessages: [],
        status: "idle" as const,
        completedTurns: 0,
        answerText: "",
        materializing: false,
        disposed: false,
        lastWidgetAt: 0,
        widgetCtx: ctx,
        unsubscribe: () => {},
      } satisfies LiveBtw2;
      state.unsubscribe = agent.subscribe((event) => handleAgentEvent(state, event));
      return state;
    }

    async function showTranscript(ctx: ExtensionCommandContext, state: LiveBtw2): Promise<void> {
      const partial = state.status === "running" && state.answerText
        ? `\n\n## Assistant (streaming)\n\n${state.answerText}`
        : "";
      const transcript = `${serializeBtw2Transcript(state.promotableMessages)}${partial}` || "# BTW2 transcript\n\nNo completed turns.";
      await ctx.ui.editor("BTW2 transcript (edits are ignored)", transcript);
    }

    /** Swap the side Agent for one with a different tool set, keeping all
     *  frozen context and completed turns. Only valid while idle. */
    function recreateAgent(state: LiveBtw2, tools: AgentTool[]): void {
      const previous = state.agent;
      const agent = deps.createAgent({
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        systemPrompt: state.systemPrompt,
        messages: previous.state.messages.slice(),
        sessionId: state.agentSessionId,
        modelRegistry: state.modelRegistry,
        rewriteProviderPayload: state.rewriteProviderPayload,
        tools,
      });
      state.unsubscribe();
      state.agent = agent;
      state.tools = tools;
      state.answerText = "";
      state.errorMessage = undefined;
      state.status = "idle";
      state.unsubscribe = agent.subscribe((event) => handleAgentEvent(state, event));
    }

    async function setBranchTools(ctx: ExtensionCommandContext, enabled: boolean): Promise<void> {
      const sessionId = ctx.sessionManager.getSessionId();
      const state = liveBySession.get(sessionId);
      if (!state) {
        safeNotify(ctx, "No active BTW2 side branch; start one with /btw2 <question> first", "warning");
        return;
      }
      if (state.runPromise || state.materializing) {
        safeNotify(ctx, "Wait for the current BTW2 response to finish before changing tools", "warning");
        return;
      }
      if ((state.tools.length > 0) === enabled) {
        safeNotify(ctx, enabled ? "BTW2 tools are already enabled" : "BTW2 tools are already disabled", "info");
        return;
      }
      state.widgetCtx = ctx;
      recreateAgent(state, enabled ? createCoreAgentTools(state.sourceSessionCwd) : []);
      refreshWidget(state, true);
      safeNotify(
        ctx,
        enabled
          ? `BTW2 tools enabled: ${CORE_TOOL_NAMES.join(", ")}`
          : "BTW2 tools disabled; the side branch is no-tool again",
        "info",
      );
    }

    async function forkState(
      ctx: ExtensionCommandContext,
      state: LiveBtw2,
      requestedName?: string,
    ): Promise<void> {
      if (state.runPromise) {
        safeNotify(ctx, "Wait for the current BTW2 response to finish or use /btw2 --stop", "warning");
        return;
      }
      if (state.materializing) {
        safeNotify(ctx, "BTW2 fork materialization is already in progress", "warning");
        return;
      }
      if (!state.sourceSessionFile || !state.sourceLeafId) {
        safeNotify(ctx, "BTW2 detached fork requires a persisted parent session with a fork anchor", "error");
        return;
      }
      if (state.promotableMessages.length === 0) {
        safeNotify(ctx, "BTW2 has no completed turns to fork", "warning");
        return;
      }

      state.materializing = true;
      state.status = "forking";
      state.errorMessage = undefined;
      refreshWidget(state, true);
      try {
        await ctx.waitForIdle();
        // Another attached client may discard or replace this state while the
        // command is suspended at the host idle barrier.
        if (state.disposed || liveBySession.get(state.ownerSessionId) !== state) return;
        const result = deps.materializeFork({
          sourceSessionFile: state.sourceSessionFile,
          sourceSessionDir: state.sourceSessionDir,
          sourceSessionId: state.ownerSessionId,
          sourceSessionCwd: state.sourceSessionCwd,
          sourceLeafId: state.sourceLeafId,
          model: state.model,
          thinkingLevel: state.thinkingLevel,
          messages: state.promotableMessages,
          toolsEnabled: state.tools.length > 0,
          name: requestedName?.trim() || defaultForkName(state.promotableMessages),
        });
        forkNotices.set(state.ownerSessionId, result);
        disposeState(state.ownerSessionId, state, false);
        safeWidget(ctx, buildForkNoticeLines(result));
        safeNotify(
          ctx,
          `BTW2 fork ready: ${result.sessionId}
Resume in a new terminal: pi --session ${result.sessionId}`,
          "info",
        );
      } catch (error) {
        state.status = "error";
        state.errorMessage = `Fork failed: ${errorText(error)}`;
        safeNotify(ctx, `BTW2 fork failed: ${errorText(error)}`, "error");
      } finally {
        state.materializing = false;
        if (!state.disposed) refreshWidget(state, true);
      }
    }

    async function browseState(ctx: ExtensionCommandContext, state: LiveBtw2): Promise<void> {
      if (state.materializing) {
        safeNotify(ctx, "BTW2 fork materialization is in progress", "info");
        return;
      }
      state.widgetCtx = ctx;
      refreshWidget(state, true);
      const running = state.runPromise !== undefined;
      const options = running
        ? ["View partial transcript", "Stop current response", "Discard side chat", "Close"]
        : [
            "Follow up",
            state.tools.length > 0 ? "Disable tools" : "Enable all tools",
            "View transcript",
            "Fork to detached session",
            "Discard side chat",
            "Close",
          ];
      const choice = await ctx.ui.select(
        `BTW2 · ${modelLabel(state.model)} · thinking ${state.thinkingLevel} · no tools`,
        options,
      );
      if (choice === "View transcript" || choice === "View partial transcript") {
        await showTranscript(ctx, state);
      } else if (choice === "Follow up") {
        const followUp = await ctx.ui.editor("BTW2 follow-up", "");
        if (followUp?.trim()) {
          if (state.runPromise) {
            safeNotify(ctx, "BTW2 started answering in another client; wait or stop it first", "warning");
          } else {
            launchPrompt(state, followUp.trim());
          }
        }
      } else if (choice === "Enable all tools") {
        await setBranchTools(ctx, true);
      } else if (choice === "Disable tools") {
        await setBranchTools(ctx, false);
      } else if (choice === "Fork to detached session") {
        const name = await ctx.ui.input("BTW2 session name", defaultForkName(state.promotableMessages));
        if (name !== undefined) await forkState(ctx, state, name);
      } else if (choice === "Stop current response") {
        if (!state.runPromise) {
          safeNotify(ctx, "BTW2 response already finished", "info");
          refreshWidget(state, true);
        } else {
          state.status = "stopping";
          state.agent.abort();
          refreshWidget(state, true);
        }
      } else if (choice === "Discard side chat") {
        const confirmed = await ctx.ui.confirm("Discard BTW2?", "Discard this no-tool side conversation?");
        if (confirmed) {
          disposeState(state.ownerSessionId, state, true);
          safeNotify(ctx, "BTW2 discarded", "info");
        }
      }
    }

    async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (!ctx.hasUI) {
        safeNotify(ctx, "BTW2 requires an interactive pi client", "error");
        return;
      }
      const sessionId = ctx.sessionManager.getSessionId();
      let command = parseBtw2Command(args);
      let state = liveBySession.get(sessionId);
      if (state) state.widgetCtx = ctx;

      if (command.kind === "help") {
        await ctx.ui.editor(
          "BTW2 help",
          [
            "/btw2 <question>       start or continue a no-tool side branch",
            "/btw2                  ask the first question, or open actions",
            "/btw2 --fork [name]   create a sleeping normal session",
            "/btw2 --stop          stop the current side response",
            "/btw2 --discard       discard the side branch",
            "/btw2 --dismiss       clear a completed-fork notice",
            "",
            "Resume a fork in another terminal with: pi --session <session-id>",
          ].join("\n"),
        );
        return;
      }
      if (command.kind === "dismiss") {
        forkNotices.delete(sessionId);
        safeWidget(ctx, state ? buildBtw2WidgetLines({
          modelLabel: modelLabel(state.model),
          thinkingLevel: state.thinkingLevel,
          status: state.status,
          completedTurns: state.completedTurns,
          lastQuestion: state.lastQuestion,
          answerText: state.answerText,
          errorMessage: state.errorMessage,
          toolsEnabled: state.tools.length > 0,
        }) : undefined);
        return;
      }
      if (command.kind === "browse" && !state) {
        const question = await ctx.ui.editor(
          "BTW2 question · no tools · Esc returns to the main session",
          "",
        );
        const text = question?.trim();
        if (!text) return;

        // The dialog round-trip can outlive this worker's original state read.
        // Re-check so a branch started by another attached client wins instead
        // of being overwritten; the submitted question then becomes a follow-up.
        state = liveBySession.get(sessionId);
        if (state) state.widgetCtx = ctx;
        command = { kind: "send", text };
      }
      if (command.kind === "send") {
        if (!state) {
          try {
            await ctx.waitForIdle();
            state = liveBySession.get(sessionId);
            if (state) {
              state.widgetCtx = ctx;
            } else {
              state = createState(ctx);
              liveBySession.set(sessionId, state);
              forkNotices.delete(sessionId);
            }
          } catch (error) {
            safeNotify(ctx, errorText(error), "error");
            return;
          }
        }
        if (state.runPromise) {
          safeNotify(ctx, "BTW2 is already answering; wait or use /btw2 --stop", "warning");
          return;
        }
        if (state.materializing) {
          safeNotify(ctx, "BTW2 fork materialization is in progress", "warning");
          return;
        }
        launchPrompt(state, command.text);
        return;
      }
      if (command.kind === "fork") {
        if (!state) {
          safeNotify(ctx, "No active BTW2 side branch", "warning");
          return;
        }
        await forkState(ctx, state, command.name);
        return;
      }
      if (command.kind === "stop") {
        if (!state?.runPromise) {
          safeNotify(ctx, "BTW2 is not currently answering", "info");
          return;
        }
        state.status = "stopping";
        state.agent.abort();
        refreshWidget(state, true);
        return;
      }
      if (command.kind === "discard") {
        if (!state) {
          forkNotices.delete(sessionId);
          safeWidget(ctx, undefined);
          return;
        }
        disposeState(sessionId, state, true);
        safeNotify(ctx, "BTW2 discarded", "info");
        return;
      }
      if (state) await browseState(ctx, state);
    }

    pi.registerCommand("btw2", {
      description: "No-tool side branch; bare command opens its prompt/actions and --fork materializes it.",
      handler: handleCommand,
    });

    pi.registerCommand("tools", {
      description: "Enable all core tools on the live BTW2 side branch (/tools off disables them again).",
      handler: async (args, ctx) => {
        const enabled = args.trim().toLowerCase() !== "off";
        await setBranchTools(ctx, enabled);
      },
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const state = liveBySession.get(sessionId);
      if (state) disposeState(sessionId, state, false);
      forkNotices.delete(sessionId);
    });
  };
}

export default createBtw2Extension();
