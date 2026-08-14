# pi-prompt-magazine

pi extension that turns the single-slot prompt stash into a **queue of stashed drafts** — a "magazine" (弹匣). Type a long draft, decide you don't want to send it, and stash it with two semicolons. Load several drafts, then browse the queue and restore any one of them into the prompt editor.

This is the pi port of the retired Prime Agent `pa-prompt-magazine` package:
the same commands, capture marker, and op-log persistence, fitted to the pi
extension API.

## Why

The built-in Ctrl+S stash holds exactly **one** draft: a second Ctrl+S is refused with "Prompt stash already has a draft". This extension adds an ordered queue with a visible queue-level UI, captured at the moment you decide not to send.

## Install

```bash
pi install ./packages/pi-prompt-magazine   # from this repo
# or
pi install /absolute/path/to/pi-prompt-magazine
```

Then start a new session (or `/reload`). Remove with `pi remove pi-prompt-magazine`.

## Capturing a draft: end it with `;;`

Type your draft (multi-line is fine) and end the **last line with `;;`**, then press Enter. The whole draft is intercepted and pushed into the magazine instead of being sent:

```
fix the typo in README
add tests for PR #42
;;            ← last line (or append ;; to the last line)
```

- The `;;` marker must be at the very end of the draft (trailing whitespace is tolerated).
- A `;;` in the middle of a multi-line draft does nothing.
- A bare `;;` (nothing else) is ignored — safe to press Enter.
- To *send* a draft that really ends in `;;`, end with `;;;` instead (one semicolon is stripped).
- Only interactive submissions are intercepted; RPC/script/extension-injected inputs always pass through.
- The marker is a constant in `magazine.ts` (`STASH_MARKER`) if you want a different one.

After a stash the editor is empty (same as the built-in Ctrl+S), and a notification reports the queue size.

## Managing the queue

| Action | How |
|--------|-----|
| Pop the Nth draft into the editor | `/magazine <n>` (e.g. `/magazine 1` for the front, `/magazine 2` for the second) |
| Browse / restore / peek / delete / reorder / clear | `/magazine` (no argument) |
| Clear everything | `/magazine-clear` (asks for confirmation) |
| Stash from a script/RPC | `/stash <text>` (programmatic entry point) |

`/magazine` without an argument lists the queue (`▸ #1 <preview>` … `#N <preview>`, front entry marked `▸`); selecting an entry opens its actions: **Restore to editor** (pops it out of the queue and puts the full text into the prompt editor), Peek full text, Move up, Move down, Delete, ← Back, plus a Clear all entry. All pops replace the current editor content.

**Closed loop:** after restoring, if you decide not to send it, append `;;` and submit — it goes back onto the queue (at the back).

## Queue widget

When the magazine is non-empty, a widget above the prompt bar shows the count and one preview row per stash:

```
Magazine: 3 stashed
▸ #1  fix the typo in README
 · #2  review PR #42
 · #3  draft plan for auth module
```

Up to 8 rows are shown (`… N more` beyond that). The widget refreshes on every change.

## Behavior

- **FIFO**: stashes append to the back; restore pops the selected draft. Reorder with "Move up"/"Move down".
- **Capacity**: up to 50 drafts. Pushing past the cap drops the oldest draft and says so.
- **Per-session, persistent**: state is stored as custom session entries (`pi.appendEntry`) — survives restart, `/resume`, and follows the session tree branch. Different sessions have independent magazines.
- **Storage-efficient op log**: each mutation persists a compact op record (`add` / `remove` / `move` / `clear`) instead of a full queue snapshot, with a snapshot anchor every 25 mutations. Realistic long-lived queues grow the session file ~10x slower than full-snapshot persistence; legacy full-snapshot payloads still load.
- **Text-only**: pasted images are not preserved (the extension API cannot reach the editor's paste snapshots that the built-in stash uses). The built-in Ctrl+S stash remains available and is separate from the magazine.

## Development

```bash
cd packages/pi-prompt-magazine
npm install        # installs typecheck deps from the published pi packages
npm run check      # strict typecheck
npm test           # typecheck + pure-model unit tests
```

Layout:

- `index.ts` — extension entry: `;;` capture interception, commands, widget, persistence
- `magazine.ts` — pure FIFO queue model + stash-marker parsing (no pi imports; unit-tested)
- `tests/magazine.test.ts` — model + marker-parsing unit tests

## Files / versioning

Per repo conventions: bump `version` in `package.json` and add a dated entry to `Changelog.md` for each change.

## License

MIT
