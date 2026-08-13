# Changelog

## [0.1.0] - 2026-08-13

- Initial release: `0017-openai-server-compaction` promoted out of
  `ren-public-package` 0.10.6 into this standalone path-installed package.
  Behavior is identical to the bundled 0.10.6 implementation; no runtime
  logic changed.
  - Default-on native OpenAI Responses server compaction (Compaction V2) at Pi
    compaction boundaries for the strict allowlist: Codex
    (`openai-codex`/`openai-codex-responses` via `POST /backend-api/codex/responses`
    trigger SSE with JWT/account headers) and the standard-Responses JSON
    routes `fluxion-gpt`/`fluxion-grok` on the exact Fluxion mirror base URL
    and `xai/grok-4.6` on `https://api.x.ai/v1` (`POST /responses/compact` with
    ordinary Bearer auth).
  - Exact final-provider-payload capture through stream decorators,
    canonicalized recent-user retention plus one opaque artifact (Codex) or
    provider-returned canonical output preserved as-is (standard), bounded
    transient retry, session-local operation leases, fail-open before the first
    opaque checkpoint and fail-closed after it, display-only success/fallback
    transcript cards, and `PI_OPENAI_SERVER_COMPACTION=0` as the emergency
    opt-out.
  - The GPT reasoning replay projection used at the branch-tail conversion
    choke point is vendored from `ren-public-package` `0021-gpt-reasoning-replay.ts`
    (pure helpers only; see `gpt-reasoning-replay.ts` header and IV-0008).
    Keep the vendored copy in sync with the authoritative 0021 module.
  - Persisted entry-type names keep the historical
    `ren-public-package.openai-native-compaction` (and `-fallback`) prefix so
    transcript cards already written into existing sessions continue to render;
    `ren-public-package` 0.11.0 no longer registers their renderers.
  - 56 unit tests and 2 integration tests carried over from the bundled suite
    (strict `tsc --noEmit` + node:test via jiti), covering the Codex/Fluxion/xAI
    allowlists, SSE/JSON parsing, checkpoint creation and replay, credential
    redaction, retry policy, leases, fallback ownership, and real Pi/model
    composition.
