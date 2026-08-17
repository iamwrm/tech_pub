# pi-unified-edit

Private, path-installed pi extension that replaces the built-in `edit` tool
with one `text` payload for multi-file, all-or-nothing edits and live previews.
It is a vendored copy of
[`mitsuhiko/agent-stuff/extensions/unified-edit.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/unified-edit.ts)
(Apache-2.0), pinned at upstream commit `13bc8f87` (2026-08-10) with local
changes marked `// LOCAL (...):`. Hash-line format attribution is in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). It is not installed by
default.

Lifecycle and validation: [`IV-0022`](../../docs/IV-DC/IV-0022-pi-unified-edit.md),
[`DC-0005`](../../docs/IV-DC/DC-0005-tool-behavior-validation.md).

## Install and fallback

```bash
pi install ./packages/pi-unified-edit
# Or use an absolute path. Start a new pi session or run /reload.
pi list   # verify
```

Remove it with `pi remove pi-unified-edit`. If it fails to load or is removed,
pi falls back to its stock `edit` tool.

## One active dialect

`PI_UNIFIED_EDIT_MODE` is read at extension registration and activates exactly
one dialect; the model sees only that dialect's prompt. Non-active payloads are
rejected with a hint naming the configured mode.

| Mode | Payload and operations |
| --- | --- |
| `hash` (`hashline` alias, default) | OMP-compatible explicit-line core. In this mode `read` emits `[path#TAG]` and `N:text`; `edit` accepts `PUT N.=M`, `PUT <N`/`>N`/`>$`, `CUT N.=M`, `REM`, and `MV`. All coordinates address the original tagged snapshot. |
| `patch` | `*** Begin Patch` / `*** End Patch`; `*** Add File`, `*** Delete File`, and `*** Update File` with `@@` context, `-` removals, `+` additions. Standard `@@ -N +M @@` line-range headers are accepted and ignored. |
| `rows` | Column-0 `[path]` sections with `@REPLACE`, `@INS.PRE`, `@INS.POST`, `@INS.BEFORE`, `@INS.AFTER`, `@APPEND`, and `@DEL N-M`; replacement context anchors the matched block and insertions target the named line. |
| `code` | Payloads beginning with `js:` or a JavaScript fence (&#96;&#96;&#96;js); they run in a `node:vm` sandbox exposing synchronous `readFile`, `readLines`, and `writeFile`; paths resolve from cwd and there is no delete API. |
| `pi` | Pi-native JSON `{"path": ..., "edits": [{"oldText": ..., "newText": ...}]}` or an array for multiple files; ordered substring replacements, existing files only. |

Use, for example:

```bash
PI_UNIFIED_EDIT_MODE=patch  pi ...
PI_UNIFIED_EDIT_MODE=rows   pi ...
PI_UNIFIED_EDIT_MODE=code   pi ...
PI_UNIFIED_EDIT_MODE=pi     pi ...
PI_UNIFIED_EDIT_MODE=hash   pi ...
```

### Hash mode example

First read the target. Hash mode transforms the successful model-facing read
result without replacing pi's built-in read implementation or renderer:

```text
[src/main.ts#A1B2]
1:const old = 1;
2:run();
```

Then copy the exact header into one edit payload:

```text
[src/main.ts#A1B2]
PUT 1.=1:
+const value = 2;
PUT <2:
+setup();
```

The four-hex tag uses OMP's normalized XXH32 low 16 bits. Safety does not rely
on 16-bit collision resistance: the session must have issued the tag, the
targeted lines must have been shown by `read`, the exact snapshot is retained,
and normal transaction preflight re-reads and byte-checks the file. Snapshots
are capped at 32 MiB and four versions per path. This mode intentionally omits
OMP's tree-sitter `N*` blocks, registers, and stale-snapshot recovery; a stale
tag asks the model to re-read. Use `write` to create new files.

## Safety and behavior

- One call can plan multiple files. Planned-file modes acquire every target's
  mutation queue in canonical sorted order, re-read every target, and dry-run
  before the first write. Drift or add collisions apply nothing; update guards
  compare the expected bytes, and add commits use exclusive `wx` creation.
- Plan-build parse, match, or invalid-UTF-8 failures apply nothing. Every
  binary/misencoded file is refused on every read path. Mid-apply rollback is
  best effort and restores only confirmed successful writes whose exact bytes
  still match this call; it never guesses at the failing path. Code mode keeps
  only the final content when one call writes a path repeatedly; on an
  exception it best-effort restores each original file and removes files the
  call created. Add/delete/update patch operations and every row operation
  share the planned transaction boundary.
- Matching is dialect-specific. Hash mode uses explicit tagged snapshot line
  coordinates and rejects stale/unseen/overlapping ranges. Rows and `pi` try
  exact content, then ignore
  trailing whitespace and normalize common Unicode punctuation/spaces while
  keeping leading and internal whitespace exact. Patch hunks add a
  both-sides-trimmed stage before punctuation normalization. Whole-line
  matching, BOM/CRLF, and valid UTF-8 including NUL bytes are preserved. Rows
  also accept a single diff-style separator space after `-`, `+`, or context
  markers, while exact content wins. Row headers must start in column 0;
  indented `[path]` text is therefore context, not a new file section.
- Errors identify the file/hunk/block where possible and say that no changes
  were applied for plan failures; unmatched rows include bounded context and
  whitespace guidance. The tool renders a stable pending header while
  arguments stream and builds the diff once the payload is complete.
- The registered name is `edit` and shadows stock pi `edit`; there is no legacy
  `{path, edits}` compatibility except the explicit `pi` dialect. Hash mode
  additionally post-processes successful stock `read` results through the
  `tool_result` event so the model receives tags and line numbers.

## Verification and maintenance

Validated target: pi 0.84.2, Node.js >= 22.8.0.

```bash
cd packages/pi-unified-edit
npm ci
npm run check
npm test
npm pack --dry-run
```

`npm test` currently drives 92 headless cases covering all five dialects,
atomicity, parser/matching diagnostics, binary rejection, abort/rollback, and
queued concurrent update/add races. The E-series behavior methodology is
statistical: use `PI_UNIFIED_EDIT_MODE=<mode> ./run_all.sh <provider> <model> <tag>`
from the gitignored `local_data/edit-ab/` pack, and compare retries/first-try
rates rather than completion alone. Prompt or dialect changes require the
[DC-0004](../../docs/IV-DC/DC-0004-meta-prompt.md) fresh-agent gate.

For the complete model × mode matrix, run `run_five_modes.sh` once per model
and give every process the same matrix tag. The runner writes
`run-metrics.json` with settled wall time beside each session; aggregate final
state, wall time, and assistant `usage` with:

```bash
python3 packages/pi-unified-edit/scripts/analyze_matrix.py --tag <tag>
```

The 2026-08-15 `five-20260815` run and interpretation are recorded in
[IV-0022](../../docs/IV-DC/IV-0022-pi-unified-edit.md).

For upstream drift, re-fetch the pinned `13bc8f87` source and diff it against
`unified-edit.ts`, ignoring `// LOCAL` regions; bump the version and add a
Changelog entry when adopting upstream changes.
