# Changelog

## [0.1.0] - 2026-08-09

- Initial `/btw2` Prime Agent extension.
  - Freeze the persisted parent branch once and run a background multi-turn side agent with the same model, thinking level, service tier, effective system prompt, and built context, but `tools: []`.
  - Keep partial, failed, and aborted turns out of the promotable transcript and leave the parent session byte-unchanged.
  - Materialize completed turns as a new archived normal session, returning an ID for `prime-agent -r <id>` without switching the parent terminal.
  - Publish fully flushed session files with same-directory, no-clobber hard links and clean staging on failure.
  - Refuse opaque OpenAI server-compaction checkpoints that cannot be replayed through the raw side-agent request path.
  - Provide daemon-compatible string widgets and dialogs with bounded, terminal-sanitized display text.
  - Add strict typechecking and unit coverage for helpers, extension lifecycle/state, detached publication, corrupt/legacy parent rejection, and terminal safety.
