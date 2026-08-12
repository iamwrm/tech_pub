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
    the new parse errors.
  - **Tests.** New `tests/regression.test.ts` (37 cases: parser strictness,
    matching-semantics locks incl. the upstream whitespace-only-needle hang
    fix, internal-whitespace strictness, the diff-style separator matrix,
    diagnostics, and chmod-0555 rollback/abort atomicity). Total suite: 44.
  - **Test-only exports.** `__test` export surface (`parseRowScript`,
    `applyRowOperations`, `applyPlan`, `applyUpdateChange`,
    `applyEditsToNormalizedContent`) for regression coverage.

## [0.1.0] - 2026-08-11
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
