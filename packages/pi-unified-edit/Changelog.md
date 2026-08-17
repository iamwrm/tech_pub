# Changelog


## [Unreleased]

## [0.3.0] - 2026-08-17

- **Default mode is now `hash`.** Unset, empty, or unknown
  `PI_UNIFIED_EDIT_MODE` values select hash (was patch). Explicit
  `patch|rows|code|pi|hash|hashline` still work. Owner decision after the
  five-mode matrix: hash tied patch at 92/96 with lower mean/p95 wall and
  fewer tokens. Set `PI_UNIFIED_EDIT_MODE=patch` to keep the previous
  default. Because hash is default, successful stock `read` results are
  transformed to `[path#TAG]` plus `N:text` unless another mode is selected.
- **Default-mode regression.** Unset, empty, and invalid env values now
  register the hash prompt and read transformer. Total suite: 92 tests.

## [0.2.0] - 2026-08-15

- **Hash mode (`PI_UNIFIED_EDIT_MODE=hash`, `hashline` alias).** Added a
  Node-native implementation of the explicit-line core of oh-my-pi's
  hashline format. Successful stock `read` results become `[path#TAG]` plus
  `N:text`; `edit` accepts original-snapshot `PUT N.=M`, `PUT <N`/`>N`/`>$`,
  `CUT N.=M`, `REM`, and `MV`, including multi-file payloads. Tags use the
  OMP-compatible normalized XXH32 low 16 bits, but validation also requires
  an exact session-issued snapshot and read-seen line anchors. Stale tags,
  unseen lines, overlapping ranges, binary files, and unsupported `N*`/
  register syntax fail closed. Hash plans reuse the transaction-wide queues,
  dry run, drift guards, exclusive adds, CRLF/BOM preservation, and rollback
  of the other planned-file modes. OMP attribution and intentional syntax
  differences are recorded in `THIRD_PARTY_NOTICES.md`.
- **Hash regression coverage.** Added 13 deterministic tests for official
  XXH32 vectors, read transformation and offsets, original-coordinate
  operations, multi-file atomicity, stale/unseen/overlap rejection, BOM/CRLF,
  move, binary refusal, unsupported blocks, aliasing, and exact snapshot
  identity. Total suite: 91 tests.
- **Five-mode fresh-session evidence.** E1-E24 × rows/patch/code/pi/hash ×
  ds/sol/luna/opus (all `max` thinking) completed 480 retained runs (three
  provider-error attempts were rerun). Hash tied patch at 92/96 final-state
  passes and had the lowest mean wall time (23.2s), p95 (48.3s), and total
  token usage (8.810M); versus
  patch that is -10.1% mean wall, -35.6% p95, and -11.1% tokens, while median
  wall was +9.6%. Rows had the highest pass rate (95/96). Raw artifacts live
  in gitignored `local_data/edit-ab/results/five-20260815`; durable details
  are in IV-0022.
- **Validated pi target.** Development types and documentation now target pi
  0.84.2.

- **README compression.** Consolidated installation, dialect, safety, and
  validation guidance without changing runtime behavior.
- **Lock metadata cleanup.** Synchronized the package-lock root metadata with
  package version 0.2.0 and pi 0.84.2 development dependencies.
- **Concurrency-safe transaction dry run (rows/patch/pi).** The former
  rollback snapshotted targets before entering their individual mutation
  queues. If another queued writer changed or created a target while this
  call waited, preflight correctly failed but failing-path rollback could
  then revert that writer's update or delete its new file. The tool now
  acquires every target queue in canonical sorted order, re-reads and
  validates every target while all queues are held, and only then starts
  committing. Drift and add collisions abort with zero writes. Runtime
  rollback tracks only filesystem calls that completed successfully, uses
  exact byte-state comparisons, and never guesses at the failing path; add
  commits use exclusive creation (`wx`) as a final collision guard. Added
  deterministic queued-update and queued-add race regressions (78 tests).
- **Preview flicker fix (full-screen mode).** The live preview was rebuilt
  while the tool payload was still streaming: every streamed chunk changed
  the args key, which reset the preview, then the async rebuild landed and
  re-expanded the diff body — the height oscillation collapsed/expanded the
  component per chunk and rewrote every row below the tool call on each
  change (erased with `\x1b[2K` + redrawn), flickering in full-screen
  (alt-screen) mode. Previews are now built only from complete payloads
  (`argsComplete`), like the built-in edit tool: the call renders a stable
  one-line pending header while streaming, and exactly one build+invalidate
  happens per payload once the args are complete. Removed the per-chunk
  partial-args preview state (`previewBuiltFromCompleteArgs`,
  `previewPendingArgsKey`, `previewSuppressedArgsKey`). Behavior otherwise
  unchanged: the diff still appears live while the tool runs and settles.
- **Review-driven cleanup (same change set).** Duplicated first sentence in
  the rows-mode `TOOL_DESCRIPTION` removed (it was injected verbatim into
  every rows-mode prompt). Dead render state (`UnifiedRenderState.planKey`,
  `preview`, `pending`) and the dead partial-args preview branch
  (`buildPreviewPlan`/`patchTextForPreview` special case) removed; the
  preview now calls the selected mode's plan builder directly. The update preflight re-match and
  the apply-time matcher re-run in `applyUpdateChange` were provable no-ops
  (update changes always carry non-empty `oldText` ≠ `newText`, and the
  drift guard already guarantees `file.content === change.oldText`, so the
  matcher output is exactly `change.newText`) — both removed. While args
  stream, the TUI path label now uses only the cheap header extractors
  instead of a full row-script/patch parse per render frame; the full parse
  runs once args are complete. Schema description updated for the pi mode;
  README test count corrected (44 → 76).

## [0.1.1] - 2026-08-12

- **Pi mode (`PI_UNIFIED_EDIT_MODE=pi`).** Fourth dialect: pi's native JSON
  edit payload `{"path": ..., "edits": [{"oldText": ..., "newText": ...}]}`
  (array form for multiple files). Substring replacements applied in array
  order per file; all-or-nothing; never creates files; same lenient
  normalization as patch mode. Detection is `{` or `[{`-prefixed only, so a
  row-script `[path]` header is never mistaken for JSON. Tests K1-K6
  (substring, multi-file, ordering, atomicity, validation, mode gate): 76.
  **Evidence (E1-E24 x 4 models, 2026-08-13)**: first-try success is
  strongly model-dependent — luna 22/24, opus 18/22, ds 15/24, sol 2/24
  (sol retries the JSON dialect heavily). Patch stays the default; the pi
  mode exists for side-by-side comparison and as the control proving why
  the built-in JSON edit was replaced.

- Local modifications to the vendored copy (upstream pinned at
  `13bc8f87`, 2026-08-10; every changed site marked `// LOCAL (0.1.1):`).
  Review-driven: P0-1/P0-2/P1-3/P1-4 proposals validated by a 5-agent
  dynamic-workflow review, then hardened per the review, then aligned with
  real unified-diff conventions after a live session analysis.
  - **Parser strictness (P0-1).** File headers (`[path]`) must start in
    column 0; a space-prefixed `[...]` row inside `@REPLACE` is always a
    context row. Previously it was parsed as a new file section, which could
    silently truncate the op, fail with a phantom-file ENOENT, or — worst —
    silently edit a real file named like the bracket content. Also: stray
    `@@` rows, bare empty `-` rows, and space-prefixed context rows under
    `@INS.BEFORE`/`@INS.AFTER` are now parse errors with line numbers (they
    were silently ignored/discarded). `extractRowHeaderPaths` (TUI path
    labels) uses the same column-0 gate. Indented `[path]` headers are now
    rejected instead of accepted.
  - **Diagnostics (P0-2).** Typed `EditMatchError` carries the edit index;
    `@REPLACE`/`@INS.BEFORE`/`@INS.AFTER` failures are annotated with the op
    ordinal, block index, and bounded row content (rows truncated to 80
    chars, max 5 rows) plus a whitespace-semantics tip. Duplicate errors name
    occurrence lines. Update-kind mutations now have a strict drift guard
    ("file content changed since preflight (expected N chars, found M)"),
    consistent with write/delete. Not-found/no-change messages reworded to
    match the real fuzzy semantics.
  - **Atomicity (P1-4).** Mid-apply failures now trigger guarded best-effort
    rollback: raw bytes (BOM/CRLF faithful) are snapshotted per target before
    mutation; only paths this call wrote are restored, and only when their
    current bytes still equal what we wrote (never blind-overwrite a
    concurrent editor). The failing path is included (partial writes). The
    original error is always thrown, with an "Applied N of M change(s) before
    failure: [paths]" suffix and per-path rollback failures appended.
  - **Unified-diff alignment (post-review follow-up).** Row mode now speaks
    the model's native diff dialect: a single leading space after a row
    marker is a diff-style separator, and when the exact content does not
    match, the whole `@REPLACE`/anchor op is re-read diff-style (one leading
    space consumed after every `-`/`+`/context marker) and applied — exact
    content always wins, uniqueness is re-checked per attempt, and context
    lines are stripped in both pattern and replacement so a matched region is
    never re-written with its separator space. Fixes the recurring
    "`- Line two.` vs `Line two.`" first-trial failure class observed in
    real sessions (models apply their unified-diff prior to row scripts).
    Also: a space-only row inside `@REPLACE` is now a blank context row
    (previously silently dropped, producing confusing mismatch errors), and
    the bare-`-` error suggests `@DEL N` for blank-line deletion.
  - **Docs (P1-3).** `TOOL_DESCRIPTION`/`TOOL_PROMPT_GUIDELINES` now state
    the column-0 header rule, the fuzzy scope (trailing whitespace ignored;
    quotes/dashes/unicode spaces normalized; internal/leading whitespace
    exact), the diff-style separator semantics, the blank context row, and
    the new parse errors. Follow-up: hunk row order is now explicit —
    replacement `+` rows must directly follow their `-` rows; a `+` row
    after a context row is a context-anchored insertion (inserts after that
    context line) rather than a replacement.
  - **Prompt slimming (DC-0004 adoption gate).** `TOOL_DESCRIPTION` +
    `TOOL_PROMPT_GUIDELINES` reduced from 6369 to 2877 chars (-55%) by
    de-duplicating the rule text (fuzzy-match and diff-style-separator
    semantics were stated three times) and shrinking the guidelines to
    strategy-only reminders. Validated via the E1-E12 edit-task pack
    (local_data/edit-ab): baseline 36/36 across
    deepseek-v4-flash:max / gpt-5.6-sol:high / gpt-5.6-luna:max, and the
    slimmed surface also 36/36 (no regression). Behavior unchanged; only
    the injected prompt text changed.
  - **Failure diagnostics (session-driven).** Two failure patterns from a
    live session (package-removal surgery, deepseek-v4-flash:max): (a) the
    model assumed earlier ops of a multi-op script still applied after a
    later op failed — every plan-building failure (parse, match, non-UTF-8)
    now appends "No changes were applied — row scripts are all-or-nothing";
    (b) unmatched rows whose text exists in the file with a different
    leading format (indentation, numbered `4.` vs bullet) now get a
    "similar line with different leading format" note naming the exact file
    line. Guidelines gained a rule to copy exact leading formats in
    multi-op scripts. Tests G1-G4 (+ C3 updated): 54 total.
  - **Code mode (dual-track).** Payloads prefixed with `js:` or a ```js fence
    run as TypeScript/JavaScript in a `node:vm` sandbox with three
    whitelisted synchronous APIs: `readFile(path) -> string`,
    `readLines(path) -> string[]`, `writeFile(path, content)`. Paths resolve
    against the cwd; `readFile` refuses non-UTF-8 files; an exception (or
    syntax error, caught at plan build) rolls back every `writeFile` of the
    call — all-or-nothing like the row modes. Multiple writes to one file
    keep the last content; files created by the call are deleted on rollback.
    The result is a diff per written file, and the preview shows the code
    (it is not executed early). Tests H1-H8: 62 total.
  - **Single-mode selection.** The extension ships all three dialects (row
    script, apply-patch, code) but exactly ONE is active per process, chosen
    by `PI_UNIFIED_EDIT_MODE=rows|patch|code` (default rows). The registered
    tool's description/snippet/guidelines and the payload gate all follow the
    active mode: payloads in a non-active dialect are rejected with a clear
    hint naming the configured mode. The model never sees multiple formats,
    so it never has to choose. Per-mode prompts: ROWS_*/PATCH_*/CODE_*.
    Tests I1-I5 (mode isolation + end-to-end per mode): 67 total.
  - **Default mode: patch (E1-E12 evidence).** `PI_UNIFIED_EDIT_MODE` now
    defaults to `patch` (was rows). The E1-E12 edit-task pack across
    deepseek-v4-flash:max / gpt-5.6-sol:high / gpt-5.6-luna:max showed all
    three dialects at 36/36 completion, but the apply-patch dialect was the
    only one with a 36/36 first-try success rate (zero failed edit calls;
    rows had one retry in ds, code had model self-corrections on e8/e12),
    and luna's recurring e11 API stalls disappeared under patch (32s
    early-ok vs 5 hangs in rows/code). Data supports patch as the format
    models are least likely to get wrong; rows/code stay available via env.
  - **Patch guidelines: read-before-patch.** A live trap case (sol x e23,
    11 failed guesses) showed the patch dialect's guidelines were missing the
    "read the target file first" rule that the row-script mode already had —
    the model trusted task text over file content and guessed hunks until a
    unique line happened to match. Added "Read the target file first and copy
    the exact lines into your hunk: the hunk must match the file's actual
    content, not what the task text implies." Re-run: 1 edit + 1 read, one
    try. Also fixed the case instrument ambiguity that seeded the guesses.
  - **Tests.** New `tests/regression.test.ts` (37 cases: parser strictness,
    matching-semantics locks incl. the upstream whitespace-only-needle hang
    fix, internal-whitespace strictness, the diff-style separator matrix,
    diagnostics, and chmod-0555 rollback/abort atomicity). Total suite: 44.
  - **Binary safety (post-review).** All file-read paths now validate UTF-8
    and reject files with invalid byte sequences (`NotUtf8Error`, "Refusing
    to edit binary or misencoded files") instead of lossy-decoding them —
    previously ANY edit to such a file silently replaced the invalid bytes
    with U+FFFD on write. Applies to plan building, preview, the apply phase
    (`readFileForMutation`) and rollback snapshots (`readRawBytes` returns
    null for non-UTF-8). Valid UTF-8 including NUL bytes is unaffected.
  - **Tests.** F-series regression tests F1–F6: row-script @REPLACE/@APPEND,
    patch-mode Update File, multi-file atomicity, NUL-byte boundary, and the
    apply-phase last-line-of-defense. Total suite: 50.
  - **Test-only exports.** `__test` export surface (`parseRowScript`,
    `applyRowOperations`, `applyPlan`, `applyUpdateChange`,
    `applyEditsToNormalizedContent`) for regression coverage.

## [0.1.0] - 2026-08-11

- Initial vendored copy of
  [`mitsuhiko/agent-stuff/extensions/unified-edit.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/unified-edit.ts)
  (Apache-2.0), verbatim apart from a comment-only provenance header.
  - Registers a replacement `edit` tool accepting one `text` payload: a
    marked row script (`[file]`, `@INS.PRE/POST N`, `@INS.BEFORE/AFTER`,
    `@REPLACE`, `@APPEND`, `@DEL N-M`) or a Codex/apply_patch-style
    `*** Begin Patch` payload (add/delete/update file).
  - Multi-file plans with snapshot store, all-or-nothing preflight, fuzzy
    whole-line matching, BOM/CRLF preservation, and mutation-queue serialized
    writes.
  - TUI: live streaming preview, multi-file "N files" label, hyperlinked
    paths, error previews.
  - Verified: strict typecheck against pi 0.84.1 public exports + headless
    smoke tests for row-script and patch execution.
  - Not installed by default; install on demand with
    `pi install ./packages/pi-unified-edit`.
