# pa-openai-server-compaction

Prime Agent extension: **OpenAI Responses server-side compaction** for GPT-series
models. When the active model supports OpenAI's native compaction protocol, this
extension replaces Prime Agent's readable (portable) LLM summarizer checkpoint
with the provider's own opaque compaction artifact — the "compaction" half of
the two API settings OpenAI credits for tripling GPT‑5.6 Sol's ARC‑AGI‑3 score
(retained reasoning + compaction; see
<https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/>).

Prime Agent counterpart of Pi's `ren-public-package/0017-openai-server-compaction.ts`.
The two implementations share the wire protocol and safety model but are
independent packages because Prime Agent's runtime differs in ways that matter
(see [Prime Agent vs Pi](#prime-agent-vs-pi)).

## What it does

1. **Compaction (`session_before_compact`)** — instead of summarizing the
   discarded history with the LLM, the extension replays the exact final
   provider payload of the last normal request, appends a
   `{"type":"compaction_trigger"}` item (Codex lane) or sends the raw input
   (standard Responses lane) to the provider's compaction endpoint
   (`https://chatgpt.com/backend-api/codex/responses` for Codex), and stores
   the returned encrypted artifact in the `CompactionEntry.details` as the
   native checkpoint. The entry `summary` is the shim
   `[OpenAI native compaction checkpoint]`.
2. **Replay (`before_provider_request`)** — every later provider request on
   the same branch has its payload input replaced with the persisted replay
   history: recent real user items (≤ 64k tokens, retained by the same rules
   Pi validates) plus the opaque artifact. The model therefore consumes the
   provider-native checkpoint instead of a readable summary.
3. **Terminal enforcement (provider decorator)** — a decorated
   `streamSimple` for `openai-codex-responses` (and the standard
   `openai-responses` lane for the allowlisted mirror providers) re-validates
   the armed replay plan against the exact final payload and captures the
   payload snapshot that the next compaction needs. This is the same
   AsyncLocalStorage request-ownership design Pi uses.

### UI feedback

After a native checkpoint commits, a persistent widget appears above the
prompt bar (session-local, never part of the LLM context):

```text
⚡ Native Responses compaction active
   Compaction V2 · input 5,823 · cache read 4,608 (79.1%) · output 251
   ⚠ Do not switch providers or disable compaction mid-session;
     old context is an opaque checkpoint.
```

The widget stays visible until the session ends, the branch changes, or the
model switches (session reset), and is cleared when compaction falls back to
Prime Agent's readable compactor. The footer status shows the usage line; a
failed native attempt shows a redacted reason via `notify`.

### Failure policy

- **No native checkpoint yet**: native failure falls back to Prime Agent's
  readable compactor, with a UI warning containing a redacted reason.
- **Native checkpoint exists**: failure cancels compaction and blocks provider
  requests rather than mixing an opaque artifact with a readable fallback
  (mixing would silently drop the authoritative old context).
- Model/provider switches away from a supported endpoint while a native
  checkpoint exists are blocked with a clear error, exactly like Pi's policy.
- **Shared provider registry resets**: Prime Agent's `ModelRegistry.refresh()`
  resets the process-global provider registry and re-applies only its own
  registrations, so a refresh from a session that never loaded this extension
  can replace the decorated streams with the built-in raw ones. Raw streams
  cannot enforce the opaque replay. `before_provider_request` therefore
  re-asserts the decorated registrations idempotently on every request: the
  affected request is blocked once with a clear, actionable message, and the
  next request (including the session's auto-retry) restores replay
  automatically.

## Installation

```bash
prime-agent package install ./packages/pa-openai-server-compaction
# restart the session to load the extension
```

Enabled by default for allowlisted models. Opt out with
`PA_OPENAI_SERVER_COMPACTION=0` (or `false`/`no`/`off`).

### Supported models (allowlist)

| Adapter | Provider / API | Models | Endpoint |
| --- | --- | --- | --- |
| `codex-trigger-sse` | `openai-codex` / `openai-codex-responses` | any Codex catalog model (e.g. `gpt-5.6-sol`) | `https://chatgpt.com/backend-api/codex/responses` |
| `standard-responses-json` | `fluxion-gpt` / `openai-responses` | `gpt-5.5`, `gpt-5.6-sol` | `https://fluxionai.space/v1/responses/compact` |
| `standard-responses-json` | `fluxion-grok` / `openai-responses` | `grok-4.5` | `https://fluxionai.space/v1/responses/compact` |

The allowlists are exact tuples (provider, api, model id, base URL) and are
deliberately conservative; `STANDARD_RESPONSES_MODELS` in the source is the
extension point for additional standard-Responses mirrors.

## Prime Agent vs Pi

The Pi implementation (`0017`) and this package share the protocol, parsers,
persistence schema (`strategy: "openai-responses-compaction-v2"`), and safety
checks. The differences are deliberate:

1. **Per-session state.** Prime Agent loads an extension factory once per
   process and shares the resulting handlers across the parent AgentSession
   and RLM child sessions. Pi's singleton payload snapshot and generation
   counters would cross sessions under Prime Agent, so this package keys all
   mutable state (prepared-payload snapshot, generations, compaction leases,
   pending fallback diagnostics) by session id.
2. **`session_id` header.** Prime Agent's bundled pi-ai 0.7.x Codex provider
   sends `session_id` (underscore) for session correlation; Pi 0.84 sends
   `session-id` (hyphen). The compaction request must share the provider's
   cache lane, so `buildCodexCompactionHeaders` uses `session_id`.
3. **No `pi-ai/compat`.** pi-ai 0.7.x exposes the raw stream functions
   (`streamSimpleOpenAICodexResponses` / `streamSimpleOpenAIResponses`) instead
   of the `openAICodexResponsesApi()` compat factory; the package composes its
   own `ApiProvider`-shaped streams.
4. **No reasoning-replay import.** Pi's `0017` optionally applies
   `0021-gpt-reasoning-replay` while converting branch tails. That is the
   "retained reasoning" half of OpenAI's finding and is intentionally out of
   scope here; Prime Agent's native Codex provider already requests
   `reasoning.encrypted_content` and the Responses API preserves reasoning
   continuity within the same provider lane.
5. **No TUI entry renderers / `pi.appendEntry`.** Prime Agent has no
   `registerEntryRenderer` for custom entries, and the shared extension runtime
   makes `pi.*` action identity ambiguous under RLM concurrency. The package
   therefore uses session-local UI only: a persistent **above-editor widget**
   (`ctx.ui.setWidget`) while the session runs on a native checkpoint, a
   footer status with the usage summary, and `ctx.ui.notify` for failures; the
   compaction entry's shim summary remains the transcript record.
6. **Environment variable.** `PA_OPENAI_SERVER_COMPACTION` instead of
   `PI_OPENAI_SERVER_COMPACTION`.
7. **Result shape.** Prime Agent reads the `session_before_compact` result
   synchronously at an idle boundary, so the lazy `get compaction()` /
   `get cancel()` re-validation getters Pi needs are replaced by a final
   synchronous branch/snapshot validation before returning.

## Is there a strong dependency on the portable (readable) summary?

This is the key Prime-specific question. Prime Agent always materializes the
compaction entry's `summary` as a `compactionSummary` message in the LLM
context (`buildSessionContext` → `convertToLlm` wraps it in a `<summary>`
envelope). With this extension active, that text never reaches a supported
provider because `before_provider_request` replaces the payload with the replay
history. The remaining consumers of the *text* are degraded to the shim:

| Consumer | Effect with a native checkpoint | Notes |
| --- | --- | --- |
| Provider payload (supported lane) | Replaced by replay history | the point of the extension |
| Transcript / compaction UI | Shows the shim text | acceptable; usage is exposed via `formatCompactionUsage` status |
| HTML export / ACP metadata / `agent_observe` previews | Shim text | readable export of an opaque checkpoint is inherently lossy |
| Branch summarization / tree navigation | Branch summaries are generated from the replayed context (recent user items + artifact) | same behavior as Pi `0017`; an opaque checkpoint cannot be re-summarized readably |
| Refinement / auto-refinement inputs | Shim text | cosmetic |
| Fallback after model/provider switch | Blocked by design (Pi parity) | do not mix opaque + readable |

The structural dependency on `firstKeptEntryId` / `tokensBefore` / `details` is
unchanged: Prime Agent's compaction entry model is the same, so the native
checkpoint participates in session resume, forking, and tree navigation exactly
like a normal compaction entry.

**Bottom line:** Prime Agent has no *strong* dependency on the readable summary
*content* for correctness of continuation on the same provider; the summary is
a presentation/portability artifact. Keeping only server-side compaction for
allowlisted GPT-series models (the Pi 0.9+ policy, now default-on) is safe and
matches OpenAI's ARC-AGI-3 evidence that the provider-native checkpoint
preserves learned state across long runs far better than a readable summary.
If you ever need readable history again, set `PA_OPENAI_SERVER_COMPACTION=0`
before resuming the session; sessions that already contain a native checkpoint
will refuse readable fallback by design.

## Support check command

`/server-compaction-check` reports whether the current model/provider combo can
use server-side compaction, without sending anything to the provider:

```text
Native Responses compaction check
  feature:      enabled
  model:        openai-codex/gpt-5.6-sol
  endpoint:     https://chatgpt.com/backend-api/codex/responses (codex-trigger-sse)
  supported:    YES
  checkpoint:   native checkpoint active
  snapshot:     available (next compaction can run native)
  auth:         ok
```

The report is shown as a temporary widget above the prompt bar (auto-clears
after 15s) and printed to stdout in headless mode.

`/server-compaction-check live` additionally runs a **real dry-run compaction
request** against the provider: a minimal synthetic input + `compaction_trigger`
is posted to the compaction endpoint and the returned artifact is validated.
This is the definitive "does the backend actually support it" probe (the
allowlist is conservative by design but cannot prove backend support). It
costs a few fractions of a cent and does **not** touch the session — no
checkpoint is created or persisted.

```text
  live dry-run: OK · artifact cmp_0d5ee24d… · Compaction V2 · input 12 · output 214 · total 226
```

## Development

```bash
npm run check        # strict typecheck (tsc --noEmit)
npm test             # check + node:test unit tests (node --experimental-strip-types)
uv run --project tests/py python -m unittest discover -s tests/py -v   # Python/uv protocol tests
```

### Test layout

- `tests/openai-server-compaction.test.ts` — 44 unit tests for the pure logic:
  allowlists, headers, retention, artifact parsing (SSE + JSON), checkpoint
  details round-trip, replay reconstruction, payload building/rewriting,
  summarizer detection, diagnostics.
- `tests/py/` — uv-managed Python harness:
  - `mock_codex_server.py` — stdlib mock of the Codex compaction endpoint
    (and the standard `/responses/compact` JSON lane) that validates the wire
    contract (auth/account/session/feature headers, `compaction_trigger` body)
    and serves scripted scenarios (success, HTTP 500 retry, overload event
    retry, `response.failed`, incomplete stream, bad artifact, no artifact).
  - `driver.mjs` — Node stdio bridge that runs the **real TypeScript module**
    so the Python tests exercise the actual implementation end to end.
  - `test_basic.py` — 15 tests covering the wire contract and client behavior
    (retries, error classification, artifact+usage parsing, replay history).

### Live dogfood scripts

`tests/py/dogfood1.mjs` (real-token protocol round trip) and
`tests/py/dogfood2.mjs` (opaque-artifact fidelity proof: a secret placed only
in an assistant message is recalled through the artifact after compaction)
exercise the module against the live ChatGPT backend, and
`tests/py/sdk-check.mjs` runs the `/server-compaction-check` command in a real
SDK session with the extension loaded through the package manager. They
require a real Codex OAuth token at `/tmp/pa-dogfood-cred.json`
(`{"access": "...", "accountId": "..."}`) and egress the backend accepts
(e.g. a Tailscale exit node); they consume a small amount of ChatGPT quota.
These are manual dogfood tools, not part of `npm test`. Results are recorded
in IV-0009.

## License

MIT
