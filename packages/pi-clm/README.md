# Vendored pi-clm

Private copy of [lolipopshock/pi-clm](https://github.com/lolipopshock/pi-clm),
version 1.0.0 at `b84a9d7cbb625cd39539db3bcef72ea9cc89aa89`.
Local version: `1.0.0-ren.3`. Requires Pi >=1.0.4.

Upstream is not modified. All local changes live in this directory.

## Differences from upstream

| Area | Upstream 1.0.0 | This copy |
| --- | --- | --- |
| Managed continuity note | Appended to the tail of every request | Fixed at the projection boundary, or leading without a projection |
| Note timestamp | `Date.now()` per request | Constant `0` |
| Cache diagnostics | None | Hash-only traces, `/clm-trace status\|on\|off` |
| Encrypted reasoning | Preserved | Preserved (unchanged) |
| Editing, budget, overflow, saved schemas | — | Unchanged |

The placement fix is automatic once this version is loaded. Nothing needs to be
enabled, and no saved data is migrated.

## Install and restart

From the repository root:

```sh
npm ci --prefix packages/pi-clm
pi install ./packages/pi-clm
pi list
```

Replace the existing `npm:@lolipopshock/pi-clm` registration, rather than loading
both copies. Preserve its position in the package list. On the owner's macOS
host, this replacement has been made in `~/.pi/agent/settings.json`.

Restart the affected Pi process, or `/reload`, and resume the same session. Do
not use `/clm reset` or rewrite the session. The existing saved revision is kept.
No model request is needed to check activation:

```text
/clm-trace status
```

## The cache issue

### Who is affected

The trigger is upstream CLM by itself. No other extension is involved.
The camera session `01a115fe` had no native compaction entries, and the live
probes loaded only CLM and Pi's stock Codex serializer.

```text
 pi-clm enabled
   + at least one active pin or continuity annotation   -> a managed note exists
   + upstream tail placement                            -> the note moves every request
   + openai-codex Responses backend                     -> one moved item costs the whole cache
   ======================================================
   cached tokens stuck near the system prompt and tools (~6k)
```

Sessions without active annotations never had the problem. Other providers run
the same CLM code, but only Codex was measured. A strict prefix cache should
lose only the tail.

### What went wrong

The note is a request-only user message rebuilt from active annotations.
Upstream put it after the newest message:

```text
 req N    [sys][ P0 P1 ... Pk ]            [NOTE]
 req N+1  [sys][ P0 P1 ... Pk  a t ]       [NOTE]   <- note left slot k+1
 req N+2  [sys][ P0 P1 ... Pk  a t a t ]   [NOTE]   <- and moved again
```

The note bytes never changed, only their position. One would expect the cache
to cover `[sys][P0..Pk]`. Codex instead fell back to about 6,000 cached tokens
on every request. Codex evidently does not cache a plain prefix of the JSON
items. The backend's rendering is private, so this documents the client-side
trigger, not the server mechanism.

Camera session timeline:

```text
 cached
 250k ┤━━━━━━━━━━━━━━━━━━━┓  <- annotations created: cache stops growing (250,496)
      │                   ┃     a high hit ratio hid the stall for 3 requests
      │                   ┃  <- revision 2 discards the old prefix
   6k ┤                   ┗━━━━━━━━━━━━━━━━━━━━━  22 requests at 6,016
      └─────────────────────────────────────────▶ requests
```

The rewrite did not cause the failure. It removed the old prefix that had been
hiding it.

### The fix

`src/continuity-placement.ts` inserts the note at a position that only changes
when CLM state changes:

```text
                       projection boundary (fixed until the next accepted edit)
                                    │
 req N    [sys][ projected prefix ][NOTE][ s1 s2 ]
 req N+1  [sys][ projected prefix ][NOTE][ s1 s2 a t ]
 req N+2  [sys][ projected prefix ][NOTE][ s1 s2 a t a t ]
          └── each request is an exact prefix of the next ──┘

 no projection:     [sys][NOTE][ raw conversation ... ]
 no annotations:    identical to upstream
```

The context hook, context-snapshot reconstruction and accepted-edit view all use
the same placement. The boundary is `effective.length - visibleSuffix.length`.
Visibility filtering, observation caps and the overflow guard all preserve
message count, so the arithmetic holds after each of them. The boundary is always
the end of an earlier request's input, so it cannot split a tool call from its
result. Resume and `/tree` rebuild the position from the saved checkpoint, so no
extra state is stored.

The note stays outside the editable mirror. Pins and annotation resolution behave
as before.

### Evidence

All runs used copied camera history, Pi 1.0.4 and the official Codex
`gpt-6.1-sol` route. Configuration and routing hashes were fixed within each series.

| Test | Cached / input tokens |
| --- | ---: |
| Identical repeat keeping all 54 encrypted reasoning items | 90,368 / 90,482 |
| Same growth input, note **moved** to the new tail | 6,144 / 90,475 |
| Same growth input, note **kept** in place | 87,552 / 90,475 |
| Actual patched hook, three growing calls | 6,144 → 87,552 → 90,240 |

The moved and kept rows differ only in note position. This control also ruled
out the earlier encrypted-reasoning hypothesis. The rejected `1.0.0-ren.2`
`/clm-cache` command and `PI_CLM_CODEX_PLAINTEXT_REPLAY` stripping were removed.

These runs used reconstructed instructions, disabled tool selection and neutral
sentinels. They did not execute the camera task. The full record is in
[IV-0034](../../docs/IV-DC/IV-0034-vendored-clm-cache-diagnostics.md).

### Checking it works

After loading this version in a session with active annotations, cached tokens
should keep growing with input. In a trace, consecutive `terminal` records should
show `configChanged: false` and `previousInputIsPrefix: true` on ordinary tool rounds.

### Known limits

These are not regressions against upstream, but they still affect caching or behavior:

- **One-call notices remain at the tail.** Outcome, overflow, budget, pressure and
  continuity-size notices are appended for one request and then dropped. By the
  same mechanism, each one probably costs one cache miss on the next request. The
  overflow guard can repeat while the context stays over its limit.
- **Annotation changes invalidate from the note onward.** Adding, editing or
  resolving an annotation costs one miss from the boundary. Without a projection,
  that is the whole conversation.
- **Resume recovery moves the note once more.** After a rebased retry-error
  recovery, the next request uses the new checkpoint's boundary.
- **Recency is weaker.** Obligations now come before recent turns instead of after
  them, and without a projection before the whole conversation. The effect on
  pin/obligation adherence is unmeasured.
- **Native compaction ordering is mock-tested only.** Pi compaction clears the
  projection, so the note then comes before the native replacement history. SDK
  mock tests pass; no live Codex request has used this ordering.

## Diagnostics

Diagnostics are on by default. `/clm-trace off` closes the trace;
`/clm-trace on` starts a new file. These commands affect only the current
process/session and do not append context or settings entries.
`PI_CLM_DIAGNOSTICS=0` disables diagnostics at startup.
`PI_CLM_TRACE_DIR` overrides the directory.

### Trace files

Default location:

```text
~/.pi/agent/pi-clm-traces/<session-id>/<time>-<pid>-<uuid>.jsonl
```

New directories use mode 0700; files use mode 0600. Each run stops recording at
16 MiB. There is no automatic deletion or aggregate disk quota. Use
`/clm-trace status` to see the exact file and any write failure or size limit.

Records include:

- Request body, instructions, tools, cache key and other option SHA-256 hashes.
- CLM revision and source/projected message counts.
- Common serialized input-item prefix length and byte count, changed
  configuration fields, and the first changed item/field.
- Hashed allowlisted routing/account/request headers, HTTP status, response ID
  hashes, provider token/cache usage and reported service tier, and Pi's normalized assistant usage.
- Pi/package/Node versions and branch/native-compaction markers.

No prompt text, tool schema text, tool arguments, ciphertext, bearer tokens,
cookies or raw account IDs are written. Hashes are deterministic, not encryption.
They reveal equality and can permit guessing low-entropy values. Treat these
files as private diagnostics, not as public-safe telemetry.

### Observation points

`provider-hook` observes the payload at this extension's position in
`before_provider_request`. Later hooks may change it.
With `pi-openai-server-compaction >=0.3.7` loaded, `terminal` observes its
prepared final body after the original payload-hook chain and native replay.
The optional peer uses a session-bound event bus and detached payload copy;
neither package imports the other's runtime. Without that peer, only the
provider-hook observation is available. Another provider replacement can
bypass this bridge. The bridge only observes; it is not part of the cache fix.

### Reading a trace

Compare consecutive `terminal` records on the same route:

- `configChanged: false` plus `previousInputIsPrefix: true` means the entire
  previous input-item sequence was preserved.
- Otherwise `changedConfigFields` and `firstDifference` identify the changed
  field/item by label and hash.
- Prefix bytes are serialized item bytes, not tokens or a server cache boundary.
  Comparisons stop at 8192 items and explicitly report truncation.
- Cache usage measures what the provider reported, not why it missed.
  Stable bodies do not establish stable backend routing or cache eligibility.

Request correlation prefers a unique pipeline hash. A later hook can force a
weaker `unique-pending-route` match. Parallel, aborted or retried requests can
leave ambiguity; the trace reports candidate counts instead of inventing a
request ID. Pending requests and response IDs are bounded to 32.
Header and normalized assistant records are observations, not guaranteed
one-to-one request links.

## Development and provenance

```sh
cd packages/pi-clm
npm ci
npm test
npm pack --dry-run
```

The SDK diagnostic tests use Pi 1.0.4, a fake token and mock fetch. They require
the sibling server-compaction checkout and cover both load orders, ordinary
bodies and opaque native replay. They never call a live model.

Key local files:

```text
src/continuity-placement.ts      note placement (the cache fix)
tests/continuity-placement.test.ts
src/diagnostics.ts               trace sink and /clm-trace
src/diagnostic-fingerprint.ts    hashing, prefix comparison, routing headers
```

Original CLM documentation is kept in [UPSTREAM_README.md](UPSTREAM_README.md)
and [docs/](docs/). Its install/release instructions describe upstream, not
this private package; local deviations in `docs/` are marked "Local (ren)".
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md),
[Changelog.md](Changelog.md) and the local lifecycle
[IV-0034](../../docs/IV-DC/IV-0034-vendored-clm-cache-diagnostics.md).
