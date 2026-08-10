# Changelog

## 0.1.2 (2026-08-10)

- Fix post-compaction session bricking (`Converting circular structure to
  JSON` on every request after a native checkpoint). Root cause: Prime
  Agent's `ModelRegistry.refresh()` (model list/catalog RPC, model switch,
  reload) resets the process-global provider registry and re-applies only its
  own registrations, so a refresh from any session whose registry lacks this
  extension silently replaced the decorated `streamSimple` with the built-in
  raw stream. Raw streams cannot enforce the opaque replay (no request
  scope), the arming-failure backstop returned a circular payload, and every
  request — including the session's auto-retries — died with the confusing
  circular-JSON error until session reload.
- Self-heal: `before_provider_request` now idempotently re-asserts the
  decorated provider registrations on every request, so the next request
  (including the session's auto-retry) restores replay automatically. The
  affected request is blocked once with a clear, actionable message instead
  of the circular backstop.
- Replace the circular `blockedProviderPayload` with a serialization-throwing
  blocking payload whose failure message explains the shared-registry reset
  and the automatic recovery.

## 0.1.1 (2026-08-10)

- Fix session bricking (`Converting circular structure to JSON` on every
  request retry) caused by the `before_provider_request` arming-failure
  backstop: when no native checkpoint exists, a transient arming failure
  (lifecycle reset racing the request, hook outside the decorated stream)
  now passes the payload through untouched instead of returning the circular
  `blockedProviderPayload`. The circular backstop now fires only when a
  native checkpoint must be protected from mixing opaque and readable
  context.

## 0.1.0 (2026-08-09)

- Initial Prime Agent package: OpenAI Responses server-side compaction for
  allowlisted GPT-series models (`openai-codex/*` on chatgpt.com and the
  exact Fluxion standard-Responses tuples).
- `session_before_compact` returns a native opaque checkpoint (shim summary +
  replay history in `details`) instead of running Prime Agent's readable
  summarizer; `before_provider_request` + a decorated provider `streamSimple`
  replay the checkpoint on every later request.
- All state keyed by session id (Prime Agent shares one extension instance
  across parent and RLM child sessions); `session_id` header matches Prime
  Agent's bundled pi-ai 0.7.x Codex provider.
- `/server-compaction-check [live]` command: static support probe for the
  current model/provider combo (feature flag, allowlist, endpoint, checkpoint,
  payload snapshot, auth) plus an optional real dry-run compaction request
  (`live`) that validates the backend returns a proper artifact without
  touching the session.
- Persistent above-editor widget while a session runs on a native checkpoint
  (`⚡ Native Responses compaction active` + usage + operational warning);
  cleared on session reset/shutdown and on readable fallback. Footer status
  shows the usage line; failures surface a redacted reason via notify.
- Failure policy: readable fallback only before any native checkpoint exists;
  after a checkpoint, failures cancel/block instead of mixing opaque and
  readable context. `PA_OPENAI_SERVER_COMPACTION=0` opts out.
- Tests: 44 node unit tests (widget + command report/handler coverage + arming-failure backstop regression tests) +
  15 Python/uv protocol tests against a mock Codex compaction endpoint
  (wire-contract validation, retries, error classification, artifact/usage
  parsing).
