# Changelog


## [0.1.1] - 2026-08-12

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
