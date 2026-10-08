# Changelog

## 1.0.0-ren.3 - 2026-10-07

- Fix managed continuity placement automatically. Keep the note at the validated projection boundary, before the growing suffix; without a projection, use a fixed leading position. Preserve all encrypted reasoning, summaries, visible messages and tool pairs. No annotation means no request-content change.
- Apply the same placement to context snapshots and newly accepted revisions. Notes stay outside the editable mirror and resolve normally; session resume and branch navigation reconstruct the placement without process-local anchors or new saved state.
- Remove the rejected `/clm-cache` command, environment switch and reasoning-stripping implementation. Matched encrypted controls warmed normally, disproving that proposed diagnosis.
- Matched position-only live controls isolated the moving note: 87,552 cached tokens with fixed placement versus 6,144 after moving it, with identical configuration and 90,475 input tokens in both. Actual patched-hook live continuation cached 6,144 → 87,552 → 90,240 tokens while retaining historical and fresh encrypted reasoning. Fixed reconstructed instructions and diagnostic responses were used; no camera tools were executed or session history changed.
- Strict types and 205 model-free package tests pass, including eight Pi 1.0.4 SDK cases in both peer orders. Old placement fails both new prefix regression tests. Server 156/root ten gates and seven uv-run captured-evidence assertions pass; package dry-runs and Markdown/whitespace checks pass.

## 1.0.0-ren.2 - 2026-10-07, rejected experiment, removed in ren.3

- Add default-off `/clm-cache plaintext|original|status` and startup `PI_CLM_CODEX_PLAINTEXT_REPLAY=1`. For active rewritten CLM history on the selected official Codex GPT route, omit encrypted reasoning items at request time. Preserve saved messages, visible text/images, tool pairs/IDs and request options.
- Keep unprojected/disabled CLM, other routes/models, unrelated same-model requests and native Responses checkpoint branches unchanged. Reload/new session restores the environment default; no saved-policy/schema migration is introduced.
- Record the allowlisted backend service tier in response usage diagnostics, independently of the requested priority hash.
- Strict types and 203 model-free tests pass, including six real Pi 1.0.4 SDK cases across both peer orders. Server-package 156 tests and ten root gates also pass with this copy.
- Two approved live diagnostic requests without existing encrypted reasoning warmed from 3,200 to 65,280 cached tokens out of 65,362. Identical final bodies and account/session routing hashes; reported total cost $0.131556. The reconstructed system prompt differed from the camera prompt, so this is workaround evidence, not an isolated causal proof or real-task quality qualification.

## 1.0.0-ren.1 - 2026-10-07

- Vendor pi-clm 1.0.0 from `b84a9d7cbb625cd39539db3bcef72ea9cc89aa89` under its MIT license.
- Add default-on, bounded hash-only payload/cache tracing and `/clm-trace status|on|off`.
- Observe an optional session-bound final-payload bridge from server-compaction 0.3.7. Record prefix/config differences and explicit correlation strength.
- Pin development dependencies to Pi 1.0.4 and require >=1.0.4 runtime peers.
- Strict types and 195 model-free tests pass on macOS/Pi 1.0.4, including four real SDK mock-transport cases in both load orders.
- Preserve CLM behavior and saved session schemas. No cache fix or live-provider qualification is claimed.
