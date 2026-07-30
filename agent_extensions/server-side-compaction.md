# IV-0003: Native OpenAI Responses compaction in the public extension bundle

Status: **active** (`ren-public-package` 0.9.2; default-on for allowlisted Codex subscription models)
Doctrine: [IV-DC.md](./IV-DC.md)

## State board

### MAINLINE

- `0017-openai-server-compaction.ts` owns minimal native OpenAI Responses
  Compaction V2 at Pi compaction boundaries.

### NOW

- Dogfood the 0.9.2 pure-native checkpoint, bounded transient compaction retry,
  retained local-image replay, exact prepared-payload cache lane, and transcript
  UI in ordinary long Codex sessions.
- Keep the protocol, replay safety, kill switch, and this IV aligned.

### NEXT

- Observe retry-budget exhaustion and recovery during ordinary long sessions.

### BLOCKED

- Direct `openai/*` API support cannot be authenticated in the current model
  catalog; current live credentials expose `openai-codex/*` only.
- Authenticated matrix expansion consumes subscription quota and requires
  approval.

### BACKLOG

- Direct OpenAI API and Azure Responses support after credentialed tests.
- Replace the manual bounded SSE call if Pi exposes raw compaction output items
  through its provider runtime.
- Retire `0017` when Pi itself persists and replays Responses compaction items.

## Current user need

Long Codex sessions should use the same high-value harness settings OpenAI
recommends for model performance:

1. Responses API rather than legacy Chat Completions;
2. retained Responses reasoning items;
3. native server compaction.

The user explicitly prefers a clean native checkpoint over a dual portable/native
representation and does not require backward compatibility with the old `0017`
schema.

## Current requirements

- Intercept Pi manual, threshold, and overflow boundaries through
  `session_before_compact` for allowlisted `openai-codex` Responses models.
- Capture the exact logical Codex payload after Pi's complete provider-request
  hook chain, including downstream prompt/tool mutations and provider
  serialization.
- Send that exact payload with only post-snapshot history and a final
  `{ "type": "compaction_trigger" }` added; all cache-relevant non-history
  fields must remain identical.
- Keep native-enabled normal turns and compaction on the same SSE/cache lane.
- Require normal stream completion and exactly one valid encrypted compaction
  item.
- Retry only bounded transient transport/5xx/explicit-overload failures; never
  retry authentication, quota/rate-limit, malformed protocol, invalid artifact,
  or abort failures.
- Persist a canonical replacement window containing newest real user text and
  Pi-serialized local user images under an approximate 64K text-token budget,
  followed by the opaque artifact.
- Store no credentials, account IDs, request headers, or complete provider error
  bodies in session details.
- Represent native success to Pi with the explicit shim summary
  `[OpenAI native compaction checkpoint]`; Pi must never pretend the ciphertext
  is a human-readable summary.
- Recursively replay the opaque window plus exact branch tail on later requests
  to the same provider/API/base endpoint. Model changes on that endpoint are
  allowed; provider/endpoint changes are not.
- If native compaction is unavailable before the first opaque checkpoint, return
  no override so ordinary Pi compaction runs. After an opaque checkpoint exists,
  cancel a failed native attempt rather than sending an uncorrelated shim-only
  summarizer request. A hybrid fallback is possible only with additional
  session-scoped pending-window correlation; `0017` deliberately does not own
  that more complex state machine.
- Fail closed when an enabled same-provider request finds a missing, malformed,
  or wrong-endpoint native checkpoint; silently sending the shim would discard
  old context.
- Honor aborts, cap response/persistence sizes, redact bounded diagnostics, and
  add no runtime dependency.
- Append a display-only transcript card after native success containing:
  - `[compaction]`;
  - an explicit encrypted/non-readable warning;
  - a warning not to disable Responses compaction or switch providers;
  - input/cache/output usage.
- Keep Pi's ordinary collapsed `Compacted from … tokens` row and tree boundary.
- Keep `PI_OPENAI_SERVER_COMPACTION=0` (`false`, `no`, `off`) as the emergency
  opt-out.

## Design

### 1. Pi remains the lifecycle owner

Pi decides when to compact and supplies `tokensBefore` plus
`firstKeptEntryId`. `0017` does not reimplement Pi's provider, session tree, or
threshold logic. It registers a narrow `openai-codex` stream decorator around
Pi's own `openAICodexResponsesApi()` so it can observe the final logical payload
outside the exception-swallowing extension hook runner. While native compaction
is enabled, that decorator deliberately selects SSE for normal Codex turns so
normal inference and the bounded compaction fetch share one prompt-cache lane.

On native success the extension returns:

```text
summary:            [OpenAI native compaction checkpoint]
firstKeptEntryId:   Pi preparation value
tokensBefore:       Pi preparation value
usage:              server compaction usage
details:            direct native checkpoint record
```

Pi appends its normal `compaction` JSONL entry. Original historical entries
remain in Pi's append-only tree, but active compatible requests are rewritten to
use the opaque server checkpoint.

### 2. Current persisted schema

The current 0.9.x schema is intentionally direct and has one discriminator:

```ts
{
  strategy: "openai-responses-compaction-v2",
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: string,
  baseUrl: string,
  replacementHistory: ResponseItem[],
  createdAt: string,
  responseId?: string,
  usage?: Usage
}
```

`replacementHistory` must end in exactly one canonical item:

```json
{
  "type": "compaction",
  "encrypted_content": "opaque provider ciphertext"
}
```

Optional provider item ID and safe turn metadata are preserved. Unknown output
fields are discarded.

Old namespaced `renPublicPackage.openaiServerCompaction` records are deliberately
ignored. They contain a readable portable summary, so Pi can still load them as
ordinary historical compactions without 0.9.0 native replay.

### 3. Exact prepared-payload boundary

The provider decorator wraps Pi's original `options.onPayload` callback:

```text
Pi builds Codex Responses body
  -> all before_provider_request handlers run in load order
  -> decorator receives the resulting payload
  -> terminal native replay is reapplied/validated
  -> exact logical payload snapshot is retained in memory
  -> Pi's normal SSE transport sends it
```

This boundary includes downstream `before_agent_start` instructions, later
provider-payload mutations, active tool order/serialization, reasoning, text
options, service tier, cache key, feature flags, and unknown future fields. The
decorator preserves all of them rather than reconstructing a request from
`ctx.getSystemPrompt()` and `pi.getAllTools()`.

A snapshot is keyed by session, active branch leaf, exact model, API, and base
endpoint. Startup/reload, tree navigation, model selection, shutdown, and any
saved compaction clear it. If no exact compatible snapshot exists before the
first opaque checkpoint, native creation fails open to Pi's readable compactor;
a missing snapshot after native ownership cancels instead.

At compaction, the request is:

```text
clone(final prepared payload)
+ provider-converted entries after the captured branch leaf
+ compaction_trigger
```

`previous_response_id` is removed. The same remote feature header,
`session-id`, user agent, model, instructions, tools, reasoning, text controls,
`prompt_cache_key`, and other non-history fields are preserved. The current
implementation forces native-enabled Codex turns to SSE because a separate
manual compaction fetch cannot reuse Pi's private cached WebSocket connection;
live testing proved that exact bodies across the WebSocket/SSE boundary still
returned zero cache, while the shared SSE lane returned a 98.7% hit.

Tail conversion still uses `openAICodexResponsesApi().streamSimple` with a
synthetic token, loopback base URL, and a capture that throws before transport.
The converter receives the full registered tool catalog so historical
`addedToolNames` records remain serializable even if a tool is inactive at the
current leaf. This catalog is **not** used to build the remote request's tool
list: that list and its active order come unchanged from the exact prepared
payload snapshot. Focused extension-level coverage proves a deferred tool-search
record is reconstructed while an unrelated inactive definition does not enter
history. This avoids reimplementing Pi's reasoning/tool item serialization and
must be re-checked on Pi upgrades.

### 3.1 Bounded transient retry

The manual compaction call has one five-minute operation deadline and at most
three byte-identical attempts:

```text
generic transport / truncated stream / retryable HTTP:
  attempt 1 -- wait 0.5 s --> attempt 2 -- wait 1 s --> attempt 3

explicit server_is_overloaded / slow_down:
  attempt 1 -- wait 30 s  --> attempt 2 -- wait 60 s --> attempt 3
```

Retryable means fetch/body-reader transport failure, a lifecycle stream that
cleanly ends before completion, HTTP 408/500/502/503/504, or an SSE provider
error carrying the explicit code `server_is_overloaded` or `slow_down`.
Authentication, HTTP 429/quota, malformed SSE/JSON, invalid completion state,
missing/conflicting artifacts, response/persistence-limit failures, and aborts
stop immediately. Backoff is abort-aware. Reusing the exact body/session/cache
headers preserves the logical compaction operation and avoids broad message-text
guesses about retryability.

### 4. Retention and replay

After a valid server response, the local replacement window is:

```text
newest real user text + Pi-local input_image data URLs,
approximately <=64K text tokens and <=8 MiB persisted JSON
+ canonical encrypted compaction item
```

AGENTS/environment/skill/hook/internal context envelopes are not duplicated as
explicit retained user messages. Pi-serialized local image data URLs are
retained, but arbitrary remote/signed image URLs from downstream hooks are
excluded to avoid persisting URL credentials. Pi 0.83 does not expose user audio
through this serializer, so audio retention remains unsupported. The encrypted
item remains authoritative for compressed history.

Before a later normal provider request, `0017` finds the latest compaction on the
active branch. If it is a valid checkpoint for the same provider/API/base URL,
it replaces Pi's shim/kept payload with:

```text
replacementHistory + converted post-boundary branch tail
```

It removes stale `previous_response_id` and legacy `messages` fields. Provider
payload options such as model, instructions, tools, reasoning, cache key, and
service tier remain untouched.

A completed turn from another model/provider is serialized into the tail rather
than silently discarded. Returning to a compatible Codex endpoint can therefore
continue from the opaque checkpoint plus intervening visible turns, although the
foreign provider itself could not interpret the checkpoint and may have made
less reliable decisions. The UI warning reflects that limitation.

### 4.1 Artifact mental model and cardinality

Treat `encrypted_content` as **client-carried sealed compacted state**, not a
hash/database address and not the original transcript encrypted verbatim:

```text
large history -> semantic compaction -> encrypt/authenticate -> base64 blob
```

OpenAI documents standalone compaction as stateless and ZDR-friendly and says
the opaque item carries prior state/reasoning. A pointer alone could not satisfy
that contract without retained customer data. Internal metadata/pointers may
exist, but the blob must carry enough state to continue. Evidence is consistent:

```json
{"input_tokens":247712,"artifact_utf8_bytes":1720,
 "decoded_bytes":1289,"decoded_entropy_bits_per_byte":7.844}
```

The 247K probe was highly repetitive, so 1.7 KiB is evidence of semantic
compression, not a general size bound.

Artifact counts are deliberately different by layer:

```text
append-only Pi JSONL:       A, B, C  (historical checkpoints remain)
latest active replay:             C  (exactly one artifact)
recursive compact:          C + tail + trigger -> D
next active replay:                      D
server response accepted:        exactly one new artifact
```

OpenAI permits stateless chains containing older items and recommends pruning
before the latest compaction item. `0017` always selects the latest active-branch
checkpoint; a persisted window with multiple artifacts or a response producing
zero/multiple artifacts is rejected before replay/persistence.

### 5. Fallback ownership and replay safety

Before the first native checkpoint, a failed native attempt returns `undefined`
and Pi's ordinary readable compactor owns the operation. This is the only
fail-open path.

After an opaque checkpoint exists, Pi 0.83's fallback summarizer cannot be
correlated by the ordinary request ID: compaction calls the agent's
`streamFunction` directly, without the normal `onPayload` hook, and gives each
summary a fresh routing ID. A global replay plan would therefore risk injecting
one session's ciphertext into another session. A separate implementation has
shown that a hybrid fallback can be built by stashing a native window in
session-scoped pending state and recognizing the next summarizer-shaped request.
That is a valid but larger state machine with concurrency and stale-state proof
obligations; it also conflicts with this initiative's pure-native preference.
`0017` therefore keeps the conservative policy: after opaque ownership, exhaust
bounded native retries, then cancel and report rather than sending a shim-only or
cross-session summary request.

For ordinary provider requests, replay is still prepared provisionally in
`before_provider_request` and terminally reapplied by the provider decorator.
Summarizer-shaped requests use the original structured summary input as the
normalization source, making replay insertion idempotent across downstream hook
rewrites. Malformed or wrong-endpoint current-schema checkpoints fail closed.

Once Pi saves a plain fallback compaction from a pre-checkpoint failure, that
plain entry becomes the active source of truth and no native replay is involved.

### 6. UI

`session_compact` appends one display-only custom entry only after Pi has saved a
validated native compaction. Its renderer shows:

```text
[compaction]

Codex native compaction was used for this checkpoint.

The compaction result is encrypted by OpenAI and is not human-readable in Pi.

Warning: do not turn Responses compaction off or switch providers mid-session;
old context may be much less reliable.

Compaction V2 · input … · cache read … (…) · cache write … · output …
```

The entry does not participate in model context. The old footer status and
`portable fallback retained` success card were removed.

## Non-goals

- No readable portable summary on native success.
- No decoding, inspection, or editing of OpenAI ciphertext.
- No compatibility reader for the old namespaced `0017` artifact schema.
- No pending-window hybrid fallback coordinator. Fresh request IDs alone are
  insufficient; implementing safe fallback would require explicit session-scoped
  correlation, interleaving/abort cleanup, and stale-state tests. Native failure
  after the bounded retry budget therefore cancels after opaque ownership.
- No provider reimplementation, custom WebSocket manager, `store: true`,
  automatic server `context_management`, or extension-owned
  `previous_response_id` state. The narrow stream decorator delegates to Pi's
  published Codex API and forces SSE only while native compaction is enabled.
- No branch-summary replacement for `/tree`.
- No direct OpenAI/Azure/proxy support without authenticated evidence.
- No claim that ciphertext protects Pi's complete local session; original Pi
  JSONL history remains local and readable.

## Implementation map

- Extension: `packages/ren-public-package/0017-openai-server-compaction.ts`
- Focused tests:
  `packages/ren-public-package/tests/0017-openai-server-compaction.unit.test.mjs`
- Bundle registration: `packages/ren-public-package/index.ts`
- Package metadata and history:
  `packages/ren-public-package/{package.json,package-lock.json,Changelog.md}`
- Runtime dependencies: none

## Verification

### Offline

```bash
cd packages/ren-public-package
npm run check
npm test
```

Observed offline for 0.9.2 on Pi 0.83.0:

- strict typecheck passes;
- all 122 unit tests pass, including 28 focused `0017` tests;
- all 3 integration tests pass;
- `git diff --check` passes;
- npm 0.9.2 package dry-run includes `0017` and no bundled runtime dependency.

Carry-forward UI/load evidence from the unchanged activation/renderer paths:

- explicit-opt-out extension-load/model-catalog smoke passes;
- a 100×32 tmux TUI smoke renders the complete encrypted-checkpoint warning and
  usage line without clipping.

Focused 0.9.2 coverage includes:

- strict endpoint, persisted-history, SSE, replay, fallback-ownership, tool-tail,
  exact-payload, bounded-retry, retained-image, and UI coverage;
- current Codex auth/session headers and credential redaction;
- exact final-provider-payload preservation across downstream hostile prompt and
  tool-order rewrites, reasoning, text/service options, cache key, unknown
  fields, branch-tail append, and final trigger;
- terminal fail-closed replay in the provider decorator even when Pi's extension
  runner catches a `before_provider_request` handler exception;
- encrypted reasoning and deferred tool-search retention through Pi's converter;
- terminal completion/exactly-one-artifact validation, named/CRLF/CR-only and
  future-field SSE framing, rejection of post-completion JSON events, and
  canonicalization of `compaction`/`compaction_summary` wire names;
- 64K newest-user retention, UTF-8 truncation, local image preservation,
  signed-URL and injected-context filtering, and strict persisted user/artifact
  schemas;
- at most three byte-identical attempts for explicit transient, truncated-body,
  and body-reader failures; Codex-aligned overload waits; no retries for
  permanent/protocol/size failures; and cancellation during backoff;
- strict remote and persisted usage invariants preventing cache components or
  total-token displays from exceeding provider-reported input/total counts;
- recursive same-endpoint replay across model changes;
- wrong-endpoint/malformed-checkpoint cancellation and no shim-only fallback;
- idempotent summarizer normalization for provider-hook calls versus normal
  request replacement;
- pure-native persistence, explanatory transcript rendering, usage formatting,
  and fail-open ordinary Pi fallback before native ownership.

### Recent independent implementation comparison (2026-07-30)

Recent `IgorWarzocha/howaboua-pi-stuff` changes through merge `18c8366`
provided an adversarial design check:

- its named-event/no-`[DONE]` SSE handling independently confirms the 0.9.1
  parser correction;
- its owned cached-WebSocket provider can compact via connection-scoped
  continuation and prewarm the opaque result, which is more efficient than
  `0017`'s public-provider SSE decorator but requires a provider/WebSocket
  reimplementation explicitly outside this initiative;
- its bounded retry support, plus this initiative's observed Sol overload,
  motivated the narrow 0.9.2 retry policy;
- its session-scoped pending fallback proves hybrid readable fallback is
  possible with additional correlation state, correcting the earlier overly
  absolute wording while not changing `0017`'s conservative pure-native policy;
- its active-tool-order change does not contradict `0017`: the actual remote
  tool order is snapshot-owned here, while the full catalog is used only for
  historical branch-tail conversion;
- official Codex and the comparison both exposed the local image-retention gap,
  now closed for Pi's emitted `input_image` data URLs. Official Codex also
  retains audio, but Pi 0.83's public serializer currently supplies no user
  audio item to this extension.

### Authenticated acceptance for 0.9.2

With explicit quota approval, use a disposable session and supported Codex
model:

1. Establish a synthetic nonce in older assistant/reasoning history.
2. Force a real Pi compaction boundary.
3. Verify one direct `openai-responses-compaction-v2` details object, one opaque
   item, shim summary, and no credential-shaped fields in JSONL.
4. Confirm the explanatory `[compaction]` card and usage line render.
5. Recall the nonce, restart/resume, and recall it again.
6. Compact a second time and verify recursive checkpoint replacement.
7. Switch between Codex models on the same endpoint and verify replay.
8. Simulate native failure before any opaque checkpoint and verify Pi's readable
   fallback compaction runs; after an opaque checkpoint, verify compaction is
   cancelled rather than sending a shim-only fallback request.
9. Verify an endpoint/provider mismatch fails closed rather than sending the
   shim as history.
10. Send a disposable local image before compaction and verify its canonical
    data URL survives the replacement window and restart recall; verify a
    synthetic signed remote URL is excluded in offline coverage.

Record Pi/package versions, model, usage, and deviations here.

### Authenticated results — exact payload/cache lane (2026-07-30)

Environment:

- Pi 0.83.0;
- `openai-codex/gpt-5.6-luna`, low reasoning;
- disposable isolated agent/session directories with synthetic content;
- `keepRecentTokens: 100` to create a real compactable prefix;
- a hostile extension loaded after the compaction implementation that appended
  a machine-identity instruction and reordered an extra active tool.

External reference validation:

- Tested open PR #205 (`029b2d2d353df30b2c9f98bfc27ed6d634d36bb9`),
  which contains merged/released PR #203's final-instruction capture plus the
  pending Pi 0.83 active-tool-order fix.
- 23 focused cache/provider/transport/compaction tests passed under Node.
- A live Code Mode RPC compaction persisted one native checkpoint and reported
  28,416 cache-read tokens out of 28,713 input tokens (**99.0%**).

Local diagnosis and result:

1. The first exact-logical-payload implementation still used Pi's normal cached
   WebSocket for turns and a separate manual SSE compaction fetch. A redacted
   comparison proved the latest normal payload was an exact 6/6 item prefix and
   every cache-relevant non-input field matched, yet compaction reported zero
   cache read.
2. Attempting to bridge transports with the latest assistant
   `previous_response_id` failed HTTP 400: that parameter is unsupported on the
   manual Codex SSE endpoint. This confirms that the reference's delta-only
   continuation depends on its owned WebSocket session, not merely the response
   ID.
3. `0017` now decorates Pi's published Codex provider and forces SSE while native
   compaction is enabled. The normal request and compaction fetch therefore use
   the same feature/session/cache lane without reimplementing WebSockets.
4. The corrected live run persisted one native checkpoint and reported 28,160
   cache-read tokens out of 28,520 input tokens (**98.7%**), with no warning or
   fallback.
5. A post-compaction turn successfully consumed the opaque checkpoint and
   reported 2,560 cache-read tokens out of 28,602 input tokens.
6. A recursive JSONL scan found exactly one native entry and one opaque item,
   with zero credential/header/account-key names, Bearer strings, or JWT-shaped
   strings.

This validates native creation, exact downstream prompt/tool capture, shared
cache-lane reuse, persistence, and one post-compaction replay turn. Restart,
repeated compaction, and model-switch are validated in the staged run below.

### Authenticated results — 0.9.2 post-refactor smoke (2026-07-30)

A fresh disposable Pi 0.83.0 RPC run under gitignored
`local_data/0017-live-probe/20260730T133100Z/` used
`openai-codex/gpt-5.6-luna`, low reasoning, `keepRecentTokens: 100`, no tools,
and only the instrumented current `0017` extension.

Observed:

- the live request reached the canonical endpoint with `remote_compaction_v2`,
  shared session/request IDs, `store: false`, no `previous_response_id`, and a
  final `compaction_trigger`;
- HTTP 200 returned named `response.*` SSE events, one encrypted compaction item,
  clean `response.completed`, and no `[DONE]` marker;
- Pi persisted exactly one native checkpoint, one display card, and zero plain
  fallback compactions;
- the artifact was 1528 bytes; recursive detail scanning found no
  credential-shaped keys;
- compaction reported 529 uncached + 2816 cache-read input tokens (**84.2%**
  cache hit) and 158 output tokens;
- the immediate post-compaction turn exactly recalled the synthetic nonce.

This re-proves the real endpoint path after the retry/image/tool-boundary cleanup.
The live response succeeded on attempt one, so retry classification remains
proved by deterministic end-to-end hook tests rather than a manufactured live
provider failure.

### Authenticated results — near-limit 247.7K-token compaction (2026-07-30, 0.9.2)

A disposable Luna probe under gitignored
`local_data/0017-250k-probe/20260730T141055Z/` sent repetitive common-word
filler sized to approach the 272K model context while retaining output headroom.
Pi reported 247,692 `tokensBefore`; the native endpoint reported 247,712 input
tokens, of which 247,552 were cache reads (**99.935%**).

The resulting `encrypted_content` was **1,720 UTF-8 bytes**. The active
replacement history contained exactly two items: one 256,000-byte retained
recent-user text item and one encrypted compaction artifact. The early nonce was
absent from retained user plaintext, yet exact post-compaction recall succeeded.
This shows artifact size did not scale linearly with this highly repetitive
247.7K-token input; it is not an upper bound for diverse or high-entropy
conversation history.

### Authenticated results — retained local image (2026-07-30, 0.9.2)

A second disposable Luna RPC run under gitignored
`local_data/0017-image-probe/20260730T133839Z/` generated a PNG containing a
random nonce, supplied it through Pi's native RPC `images` field, and instructed
the model to answer only `STORED`. After a padding turn and native compaction,
the model exactly recalled the nonce.

Structural checks found:

- exactly one native checkpoint, one `input_image`, and zero plain fallbacks;
- the persisted data URL decoded to 12,458 bytes with the exact same SHA-256 as
  the source PNG;
- pre-checkpoint assistant text was only `STORED` / `OK`, and the nonce was
  absent from all pre-checkpoint plaintext after image/ciphertext redaction;
- artifact size 1636 bytes and no credential-shaped detail keys;
- 974 uncached + 2816 cache-read input tokens (**74.3%** cache hit) and 158
  output tokens.

A clone truncated immediately after the checkpoint/display entries was then
resumed by a fresh Pi process. Its first turn exactly recalled the nonce again,
proving cold-restart replay from the persisted image-bearing checkpoint rather
than from the first recall response.

This proves real Pi image serialization, canonical local-image persistence,
native compaction, immediate semantic replay, and cold-restart continuity.

### Authenticated results — live SSE framing fix (2026-07-30, 0.9.1)

Environment:

- Pi 0.83.0;
- `ren-public-package` 0.9.1;
- `openai-codex/gpt-5.6-luna`, low reasoning;
- disposable RPC probe under gitignored
  `local_data/0017-live-probe/20260730T094439Z/` with
  `keepRecentTokens: 100`, `--no-tools`, and only `0017` loaded.

Findings:

1. First live attempts after 0.9.0 reached
   `POST https://chatgpt.com/backend-api/codex/responses` with
   `compaction_trigger`, `remote_compaction_v2`, exact prepared payload fields,
   and HTTP 200, but failed open to Pi readable compaction with
   `malformed SSE framing`.
2. Captured body shape: standard named SSE events
   (`event: response.created|in_progress|output_item.*|completed` + `data:`),
   encrypted `compaction` item on `response.output_item.done`, and **no**
   terminal `data: [DONE]`.
3. Parser fix in 0.9.1 accepts those fields and treats `[DONE]` as optional when
   the HTTP stream ends cleanly; completion is still enforced by exactly one
   `response.completed` plus one canonical artifact.
4. Re-probe after the fix:
   - one native `openai-responses-compaction-v2` checkpoint;
   - shim summary `[OpenAI native compaction checkpoint]`;
   - opaque artifact ~1764 bytes;
   - display-only `ren-public-package.openai-native-compaction` card with usage;
   - compaction usage `input 524 + cacheRead 2816` (**84.3%** cache hit on this
     small synthetic prefix);
   - zero credential/header/JWT-shaped keys in persisted details;
   - post-compact turn exactly recalled synthetic nonce `NCE-…`.

### Authenticated results — staged end-to-end matrix (2026-07-30, 0.9.1)

A disposable RPC session under gitignored
`local_data/0017-e2e/20260730T095639Z/` used `keepRecentTokens: 100`,
`--no-tools`, and only the instrumented `0017` extension. Generated identifiers
were assistant outputs, not user prompt literals, so exact recall could prove
opaque continuity while a recursive scan verified they were absent from the
checkpoint's retained plaintext user window.

Validated path:

```text
process 1: Luna -> generate A -> pad -> native compact #1 -> recall A
              |
              v
process 2: restart Luna -> recall A -> switch Sol -> recall A
              |
              v
process 3: Luna -> generate B -> pad -> native compact #2 -> recall A+B
              |
              v
process 4: restart Luna -> recall A+B
```

Results:

- checkpoint #1: Luna, 1828-byte artifact, 1792/2634 cache-read tokens
  (**68.0%** on the small first prefix);
- cold restart after checkpoint #1 exactly recalled assistant-generated A;
- same-endpoint `gpt-5.6-sol` replay exactly recalled A after two transient
  `servers are currently overloaded` responses; those zero-token provider
  failures were persisted as ordinary visible tail entries, and later replay
  still succeeded;
- an attempted recursive compaction during Sol overload returned provider error
  and was cancelled, not replaced by a shim-only Pi fallback, validating
  fail-closed ownership;
- checkpoint #2: Luna, 2276-byte artifact, 7936/8142 cache-read tokens
  (**97.5%**), recursively incorporating checkpoint #1 plus visible tail;
- exact A+B recall succeeded immediately after checkpoint #2 and from another
  fresh process;
- final JSONL contained exactly two native checkpoints, two display entries,
  zero plain compactions, no credential-shaped checkpoint keys, and neither
  assistant-generated identifier in checkpoint plaintext after ciphertext was
  redacted for inspection.

This closes the staged restart, recursive-compaction, same-endpoint model-switch,
and remote-failure ownership rows. Sustained-provider-failure recovery remains
an operational concern rather than an untested safety branch.

## Evidence

### Prior authenticated protocol evidence (hybrid 0.7.0, 2026-07-26)

On Pi 0.82.1 with `openai-codex/gpt-5.6-sol`, the same Responses V2 endpoint,
feature header, trigger, SSE completion, and opaque artifact protocol succeeded.
A fresh process resumed a cloned session whose readable summary had been
redacted and exactly recalled a synthetic 16-character nonce from the opaque
artifact. No credential/account/header/JWT-like field was found in persisted
session data.

This validates the provider protocol and replay premise, not the new 0.9.0
single-representation schema or UI. Disposable evidence remains gitignored under
`local_data/0017-live-probe/` and must not be committed.

### Official Codex source

Official `openai/codex` was inspected at
`61a44880a85d2fd0d8770908dea5733495e571c8` (2026-07-26). Current relevant flow:

1. stable, default-enabled remote compaction V2;
2. active Responses history plus `compaction_trigger`;
3. normal Responses request with instructions, tools, reasoning, cache/session
   metadata, `store: false`, and encrypted-reasoning include;
4. completed stream with exactly one compaction item;
5. bounded recent user input followed by the opaque item;
6. recursive persistence/replay on later turns.

Reproduction:

```bash
git clone --depth 1 https://github.com/openai/codex local_data/codex
rg -n "remote_compaction_v2|CompactionTrigger|encrypted_content" \
  local_data/codex/codex-rs/{core,protocol}/src
```

### Current Pi compatibility

Pi 0.83.0 still exposes `session_before_compact`, `session_compact`,
`before_provider_request`, `buildSessionContext`, `convertToLlm`, custom entry
renderers, and the public Codex payload hook, but does not natively persist or
replay `compaction_trigger` artifacts.

Re-check on every Pi update:

```bash
pi --version
rg -n "compaction_trigger|remote_compaction" \
  local_data/pi/packages/{coding-agent,ai,agent}/src
```

## Risks and re-check triggers

- **Protocol drift:** refresh official Codex before changing event names,
  retention, headers, or output validation.
- **Payload-capture drift:** verify the decorator still invokes Pi's complete
  original `onPayload` chain before terminal replay/capture and still receives
  provider-correct reasoning/tool items.
- **Transport/cache lane:** native-enabled Codex turns intentionally use SSE.
  Do not restore cached WebSockets unless Pi exposes the raw compaction output
  item and continuation state through a public post-preparation hook; exact
  logical fields across WebSocket/SSE produced zero cache in live testing.
- **Provider override conflict:** a later `openai-codex` stream registration can
  supersede the decorator and remove final-payload capture. Re-check installed
  providers when adding another Codex adapter.
- **Summarizer misclassification:** keep detection narrow to Pi's structured
  summarization instructions or `<conversation>` envelope.
- **Opaque continuity:** never silently fall through to a shim-only request when
  replay is expected.
- **Feature/provider changes:** the warning is operationally meaningful; an
  opaque checkpoint is not portable plaintext.
- **Artifact growth:** retain response and persisted-history byte bounds.
- **Trace exposure:** explicitly enabled raw tracing may contain conversation and
  opaque response bodies.
- **Multiple compaction handlers:** extension load order determines ownership;
  inspect installed packages before changing registration order.

## Consumers and interactions

- TUI, RPC, JSON, and print sessions using the public bundle and supported Codex
  models. While native compaction is enabled, normal Codex turns use Pi's SSE
  transport rather than its cached WebSocket transport.
- `0012-last-turn` and `pi-compaction-marker` still observe a normal Pi
  compaction boundary.
- The display entry is custom-entry-only and never enters model context.
- `/tree` before the compaction follows Pi's original append-only branch and does
  not include the checkpoint on that path.
- Old 0.7.x/0.8.0 hybrid sessions continue through their readable Pi summaries;
  their old native optimization is intentionally inactive.
