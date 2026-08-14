# pi-openai-server-compaction

Private, path-installed pi extension providing native OpenAI Responses server
compaction (Compaction V2) at Pi manual, threshold, and overflow compaction
boundaries through Pi's `session_before_compact` hook. It was promoted from
`ren-public-package` `0017-openai-server-compaction` 0.10.6 into standalone
package version 0.1.0; lifecycle ownership is
[`IV-0003`](../../docs/IV-DC/IV-0003-openai-server-compaction.md).

## Qualified routes

The feature is default-on for this exact allowlist; all other providers/models
use Pi's ordinary compactor.

| Provider/model | Native request and boundary |
| --- | --- |
| `openai-codex` / `openai-codex-responses` | `POST /backend-api/codex/responses`; append `compaction_trigger`, use the named SSE/cache lane and Codex JWT/account headers. |
| `fluxion-gpt/{gpt-5.5,gpt-5.6-sol}` and `fluxion-grok/{grok-4.5,grok-4.6}` | `POST /v1/responses/compact`; unary JSON and ordinary Bearer auth. |
| `xai/grok-4.6` | `POST https://api.x.ai/v1/responses/compact`; standard unary adapter, exact-model bound, ordinary Bearer auth. |

`openai-responses-compaction-v2` is one strategy name for the Codex trigger/SSE
and standard `/responses/compact` protocols, not a third protocol. Standard
routes return one opaque `cmp_…` artifact and their canonical output is replayed
as-is; their checkpoints are bound to the exact provider, base URL, and model.
No adapter uses automatic `context_management`/`compact_threshold` in-request
compaction.

## Contract and safety

- Protocol-specific stream decorators capture the exact final provider payload
  after Pi's complete request-hook chain, preserving instructions, tools,
  reasoning, cache keys, and unknown future fields. The extension persists one
  encrypted opaque artifact plus bounded retained history (or the provider's
  bounded canonical output), replays it on later requests, and adds a
  display-only usage card. Native success is represented to Pi as
  `[OpenAI native compaction checkpoint]`; the card warns that the opaque state
  is not human-readable and should not be disabled or switched to another
  provider mid-session.
- Native creation fails open before the first opaque checkpoint: Pi's readable
  compactor owns the boundary. After opaque ownership it fails closed: a failed
  native attempt cancels rather than sending an uncorrelated or shim-only
  summary request. Wrong-endpoint or malformed checkpoints likewise fail
  closed. A revocable operation lease cancels stale or overlapping results
  after session/tree/model changes, newer requests, or branch growth.
- At most three byte-identical attempts are made for abort-aware transient
  transport/truncated-stream failures, HTTP 408/500/502/503/504, or explicit
  `server_is_overloaded`/`slow_down`. Authentication, quota/429, malformed
  protocol, invalid artifact/cardinality, size-limit, and abort failures are
  not retried.
- Response and persistence sizes are bounded; credentials, account IDs,
  request headers, complete error bodies, and opaque secrets are redacted from
  session details. Direct compaction reconstructs only the qualified route's
  mandatory authentication/protocol headers; standard routes never receive
  Codex account/feature headers. `PI_OPENAI_SERVER_COMPACTION=0` (also `false`,
  `no`, or `off`) is the emergency opt-out.

## Install and development

```bash
pi install ./packages/pi-openai-server-compaction
```

`ren-public-package` 0.11.0 no longer bundles native compaction, so install
this package separately. Historical entry names retain the
`ren-public-package.openai-native-compaction` prefix so existing transcript
cards still render.

```bash
npm install        # dev dependencies (typecheck + tests)
npm run check      # strict tsc --noEmit
npm test           # node:test unit + integration suites (jiti)
```

The package has no runtime dependency. `gpt-reasoning-replay.ts` is a vendored
copy of `ren-public-package` `0021-gpt-reasoning-replay.ts`, used at the
branch-tail conversion boundary; keep it synchronized with the authoritative
module and [IV-0008](../../docs/IV-DC/IV-0008-preserve-opaque-reasoning-across-gpt-model-switches.md).
