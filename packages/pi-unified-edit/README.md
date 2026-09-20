# pi-unified-edit

Private Pi extension for hash-anchored, multi-file edits with diff previews.
It replaces `edit` and tags successful built-in `read` results. Hash is the
only dialect; `PI_UNIFIED_EDIT_MODE` is no longer read. Remove old mode settings
and start a new session or run `/reload` after upgrading.

## Install

```sh
pi install ./packages/pi-unified-edit
pi list
```

Remove the package with `pi remove pi-unified-edit` to restore Pi's stock edit.

## Read, then edit

Read each target first, using `offset`/`limit` for large files. The result has
one file snapshot tag and absolute line numbers:

```text
[src/main.ts#A1B2]
1:const old = 1;
2:run();
```

Copy the actual header from `read` into the edit tool's `text` argument:

```text
[src/main.ts#A1B2]
PUT 1.=1:
+const value = 2;
PUT <2:
+setup();
```

| Operation | Effect |
| --- | --- |
| `PUT N.=M:` followed by `+` rows | Replace original lines N–M |
| `PUT <N:` / `PUT >N:` followed by `+` rows | Insert before / after original line N |
| `PUT >$:` followed by `+` rows | Append at EOF |
| `CUT N.=M` | Delete original lines N–M |
| `REM` | Delete the file; must be the section's only operation |
| `MV path` | Move the edited file to a nonexistent destination |

Use multiple `[path#TAG]` sections in one payload. All coordinates refer to the
original snapshot, including when several operations affect one file. A bare
`+` inserts a blank row. Use `write` for new files; syntax-aware `N*` blocks,
registers, fuzzy recovery, and the former rows/patch/code/pi dialects are unsupported.

## Guarantees and limits

- The tag is normalized XXH32's low 16 bits, not an integrity check. Edits also
  require a session-issued snapshot with exactly matching normalized content
  and read-seen line anchors. Stale, unseen, overlapping, or invalid ranges
  reject the entire payload. Re-read before another line-number edit.
- Snapshots accept files up to 32 MiB and retain four versions per path.
- All targets are queued in canonical sorted order and rechecked before the
  first mutation. Invalid UTF-8, drift, or destination collisions apply nothing.
  Moves create destinations exclusively. Updates preserve BOM and CRLF;
  hash operations preserve the presence or absence of a final newline.
- Mid-apply failures roll back confirmed writes only when their bytes still
  match this call. Rollback is best effort; the failing path and concurrent
  external changes are never blindly restored. External processes can still
  race the final preflight; this is not a filesystem-wide atomic transaction.
- Streaming arguments show a stable header; completed payloads get a diff
  preview. The built-in read implementation and renderer remain Pi-owned.

## Development

Node.js >=22.8.0; Pi dependency versions are recorded in `package-lock.json`.

```sh
cd packages/pi-unified-edit
npm ci
npm test
npm pack --dry-run
```

`npm test` runs strict TypeScript and headless hash/transaction tests.
The package is two runtime modules plus one test file at the root:

- `unified-edit.ts` — Pi registration, queued writes/rollback, rendering
  (`package.json` `pi.extensions` entry)
- `hash-edit.ts` — notation, snapshots, and planning
- `edit.test.ts` — hash semantics, retired-payload rejection, and
  transaction preflight/rollback

The hash prompt is kept with its registration. Runtime Pi imports are
supplied by the host.

The retired multi-mode benchmark analyzers and detailed release history remain
in Git history. Lifecycle and historical evidence:
[IV-0022](../../docs/IV-DC/IV-0022-pi-unified-edit.md). Model-facing prompt changes
also require the [DC-0005](../../docs/IV-DC/DC-0005-tool-behavior-validation.md)
behavior validation process.

Derived from `mitsuhiko/agent-stuff`'s `unified-edit.ts` at commit
`13bc8f87970bec8830aab0f1c0487d35aa7c0917`, now maintained locally rather than
re-vendored wholesale. See [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
