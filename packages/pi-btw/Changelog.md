# Changelog

## [0.2.0] - 2026-08-11

- Add `/tools` (and `/tools off`) to toggle the full core tool set on the live
  BTW2 side branch.
  - Wraps pi's public `create*ToolDefinition` factories (`read`, `write`,
    `edit`, `bash`, `grep`, `find`, `ls`) into raw-Agent tools rooted at the
    frozen branch cwd; the Agent loop applies `prepareArguments`/validation
    and keeps looping until the final text response.
  - Recreating the side Agent preserves the frozen model/thinking/system
    prompt/session id and all completed turns; only allowed while idle.
  - The widget header flips from `· no tools` to `· with tools`; the actions
    dialog gains "Enable all tools" / "Disable tools"; a with-tools system
    note replaces the no-tool note.
  - Tool-bearing turns may contain assistant tool-call and `toolResult`
    messages; turn validation, transcript validation, and detached-fork
    publication were relaxed accordingly (`DetachedForkRequest.toolsEnabled`,
    `toolResult` messages accepted by `appendPromotedMessage`).

## [0.1.0] - 2026-08-11

- Initial `/btw2` pi extension, ported from the Prime Agent `pa-btw2` package
  with the same command surface and semantics, fitted to the pi 0.84.1 API.
  - Freeze the persisted parent branch once and run a background multi-turn
    side Agent with the same model, thinking level, effective system prompt,
    and built context, but `tools: []`.
  - The side Agent is pi's raw `Agent` (`@earendil-works/pi-agent-core`) with
    an authenticated `streamSimple` stream function (`@earendil-works/pi-ai/compat`)
    and `ctx.modelRegistry.getApiKeyAndHeaders` auth — no second full
    `AgentSession`, no extension lifecycle recursion.
  - Keep partial, failed, and aborted turns out of the promotable transcript
    and leave the parent session byte-unchanged.
  - Materialize completed turns as a new normal session in the parent session
    directory, returning an ID for `pi --session <id>` without switching the
    parent terminal; publish fully flushed files with same-directory,
    no-clobber hard links and clean staging on failure.
  - Replay `openai-responses-compaction-v2` checkpoints written by the
    `0017-openai-server-compaction` extension: validate the persisted provider
    identity, derive the post-checkpoint tail from the persisted branch (pi's
    compaction summary carries no retained-message count), and prepend
    `replacementHistory` to each final Responses payload.
  - Provide widget/dialog UI with bounded, terminal-sanitized display text.
  - Add strict typechecking and unit coverage for helpers, extension
    lifecycle/state, detached publication, corrupt/legacy parent rejection,
    and terminal safety.
