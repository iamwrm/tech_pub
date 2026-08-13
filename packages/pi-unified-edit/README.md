# pi-unified-edit

`pi-unified-edit` is a private, path-installed pi extension that **replaces
the built-in `edit` tool** with mitsuhiko's "Unified Edit" tool: a single
`text` payload that accepts either a marked row edit script or a
Codex/apply_patch-style `*** Begin Patch` payload, across multiple files, with
add/delete/update support and live streaming previews.

The implementation is a vendor copy of
[`mitsuhiko/agent-stuff/extensions/unified-edit.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/unified-edit.ts)
(Apache-2.0), pinned at upstream commit `13bc8f87` (2026-08-10) and carrying
local modifications since 0.1.1 — every changed site is marked
`// LOCAL (0.1.1):` in the source, and the provenance header logs the local
delta so a future re-vendor diff stays reviewable. It is **not installed** in
this repo's pi settings by default — install it only when you want it:

```bash
pi install ./packages/pi-unified-edit
```

Removing it restores the stock `edit` tool.

## What it does differently from stock pi `edit`

| | Stock pi `edit` | unified-edit |
| --- | --- | --- |
| Payload | `{path, edits:[{oldText,newText}]}` JSON | one `text` string: row script or patch |
| Files per call | one | many (`[file]` sections / multiple patch ops) |
| Operations | text replacement only | `@INS.PRE/POST N`, `@INS.BEFORE/AFTER`, `@REPLACE` (with unified-diff context hunks), `@APPEND`, `@DEL N-M`, plus patch `Add/Delete/Update File` |
| New-file / delete-file | via `write` / other tools | native in patch mode |
| Preview | only when args are complete | live preview while the model is still streaming the payload |
| Compatibility | accepts legacy JSON forms | no `{path, edits}` compatibility; the model must learn the row-script dialect |

It keeps pi's fuzzy edit matcher (inlined; whole-line matching added), BOM/CRLF
preservation, the file mutation queue, all-or-nothing preflight, and
multi-file diff/patch rendering. Since 0.1.1, mid-apply failures additionally
trigger guarded best-effort rollback (raw-bytes snapshots, restore only of
paths this call wrote, original error always surfaced with an
`Applied N of M change(s)` suffix); preflight remains all-or-nothing for
preflight-detectable failures.

### Local modifications (0.1.1)

- **Parser strictness**: file headers must start in column 0 (a space-prefixed
  `[...]` row inside `@REPLACE` is a context row; it previously could silently
  edit a wrong file); stray `@@`, bare empty `-` rows, and context rows under
  `@INS.BEFORE`/`@INS.AFTER` are parse errors with line numbers; a space-only
  row inside `@REPLACE` is a blank context row.
- **Unified-diff alignment**: a single leading space after a row marker is a
  diff-style separator. When the exact content does not match, the whole
  `@REPLACE`/anchor op is re-read diff-style (one leading space consumed after
  every `-`/`+`/context marker) and applied — models may write rows in either
  the adjacent or the diff style, consistently within an op; exact content
  always wins and uniqueness is re-checked per attempt.
- **Diagnostics**: typed match errors annotated with op ordinal, block index
  and bounded row content; duplicate errors name occurrence lines; update-kind
  drift guard ("file content changed since preflight (expected N, found M)").
- **Atomicity**: guarded best-effort mid-apply rollback (see above).
- **Binary safety**: every file-read path (plan building, preview, apply
  phase, rollback snapshots) now validates UTF-8 and **rejects files
  containing invalid byte sequences** instead of lossy-decoding them — a
  lossy read silently replaced invalid bytes with U+FFFD on write, corrupting
  binary files even when the edit touched other lines. Valid UTF-8 (including
  NUL bytes) is unaffected.
- **Docs**: `TOOL_DESCRIPTION`/`TOOL_PROMPT_GUIDELINES` state the exact fuzzy
  scope, the column-0 rule and the context-row single-space rule.

## Install

```bash
pi install ./packages/pi-unified-edit
# Or use an absolute path. Start a new pi session or run /reload.
pi list   # verify
```

Remove with `pi remove pi-unified-edit`.

## Mode selection

The extension ships three edit dialects (row script, apply-patch, code) and
activates exactly ONE per process — the model only ever sees the active
dialect's prompt, so it never has to choose a format:

```bash
PI_UNIFIED_EDIT_MODE=patch  pi ...   # default: apply-patch (*** Begin Patch ... *** End Patch)
PI_UNIFIED_EDIT_MODE=rows   pi ...   # row scripts ([path] + @REPLACE/@INS/@DEL/@APPEND)
PI_UNIFIED_EDIT_MODE=code   pi ...   # js: payloads with readFile/readLines/writeFile
```

Payloads in a non-active dialect are rejected with a hint naming the
configured mode. `PI_UNIFIED_EDIT_MODE` is read at extension registration
(process start); set it in the environment before launching pi.

> The tool registers the name `edit`, shadowing the built-in tool. If this
> extension fails to load or is removed, pi falls back to its built-in `edit`.

## Verification

`npm run check` — strict typecheck against the pi 0.84.1 public API
(`generateDiffString`, `generateUnifiedPatch`, `renderDiff`,
`withFileMutationQueue` from `@earendil-works/pi-coding-agent`; `Box`,
`Container`, `getCapabilities`, `hyperlink`, `Spacer`, `Text`, `Component`
from `@earendil-works/pi-tui` — all confirmed exported by pi 0.84.1).

`npm test` — 44 headless tests driving the registered tool definition:
row-script replace/insert/append/delete, patch add/update/delete, multi-file
scripts, `prepareArguments` string normalization, plus the 0.1.1 regression
suite (parser strictness incl. the silent-wrong-file regression, matching
semantics locks incl. the diff-style separator matrix, diagnostics, chmod-0555
rollback and abort atomicity).

## Development

Validated target: pi 0.84.1, Node.js >= 22.8.0.

```bash
cd packages/pi-unified-edit
npm ci
npm run check
npm test
npm pack --dry-run
```

Upstream drift check: re-fetch the source file at the pinned commit
(`13bc8f87`) and diff against `unified-edit.ts`, ignoring `// LOCAL`-marked
regions; when adopting upstream changes, bump the version and add a Changelog
entry.
