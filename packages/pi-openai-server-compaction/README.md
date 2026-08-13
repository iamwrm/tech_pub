# pi-openai-server-compaction

`pi-openai-server-compaction` is a private, path-installed pi extension that
gives long Codex and qualified enterprise-mirror sessions **native OpenAI
Responses server compaction** (Compaction V2) at Pi compaction boundaries,
instead of Pi's readable local summarizer.

It was promoted out of the `ren-public-package` bundle (`0017-openai-server-compaction`,
ren-public-package 0.10.6) into this standalone package (0.1.0). Lifecycle
ownership: [IV-0003](../docs/IV-DC/IV-0003-openai-server-compaction.md).

## What it does

- Intercepts Pi manual, threshold, and overflow boundaries through
  `session_before_compact` for strictly allowlisted providers:
  - **Codex** — `openai-codex`/`openai-codex-responses` via
    `POST /backend-api/codex/responses` with a `compaction_trigger` item and
    the named SSE lane (JWT/account headers, shared cache lane);
  - **Fluxion mirror** — `fluxion-gpt/{gpt-5.5,gpt-5.6-sol}` and
    `fluxion-grok/{grok-4.5,grok-4.6}` via `POST /v1/responses/compact` (unary
    JSON, ordinary Bearer auth);
  - **xAI** — `xai/grok-4.6` via `POST https://api.x.ai/v1/responses/compact`
    (same standard-responses-json adapter, exact-model bound).
- Captures the **exact final provider payload** after Pi's complete
  provider-request hook chain through protocol-specific stream decorators, so
  the compaction request preserves instructions, tools, reasoning, cache keys,
  and unknown future fields.
- Persists the opaque server checkpoint (one encrypted artifact + bounded
  retained user window / provider canonical output), replays it before later
  requests, and shows a display-only transcript card with usage.
- **Fail-open before the first opaque checkpoint** (Pi's readable compactor
  runs), **fail-closed after it** (a failed native attempt cancels rather than
  sending an uncorrelated summary request).
- Bounded transient retry (≤3 attempts, abort-aware backoff), bounded
  response/persistence sizes, strict credential redaction, and a revocable
  operation lease per session/tree/model lifecycle.
- `PI_OPENAI_SERVER_COMPACTION=0` (also `false`, `no`, `off`) is the emergency
  opt-out; the feature is default-on otherwise.

## Install

From this repository root:

```bash
pi install ./packages/pi-openai-server-compaction
```

`ren-public-package` 0.11.0 no longer bundles native compaction; install this
package separately to keep the feature active. Persisted entry-type names keep
the historical `ren-public-package.openai-native-compaction` prefix so existing
session transcript cards still render.

## Development

```bash
npm install        # dev dependencies (typecheck + tests)
npm run check      # strict tsc --noEmit
npm test           # node:test unit + integration suites (jiti)
```

The GPT reasoning replay projection used at the branch-tail conversion choke
point is vendored from `ren-public-package` `0021-gpt-reasoning-replay.ts`
(see `gpt-reasoning-replay.ts` and [IV-0008](../docs/IV-DC/IV-0008-preserve-opaque-reasoning-across-gpt-model-switches.md));
keep the vendored copy in sync with the authoritative 0021 module.
