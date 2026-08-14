# pi-prompt-magazine

Pi extension that turns the single-slot prompt stash into a FIFO queue of
stashed drafts. End a draft with `;;` instead of sending it, then browse and
restore any queued draft. It is the pi 0.84.1 port of the retired Prime Agent
package, retaining its commands, capture marker, and op-log format.

## Install

```bash
pi install ./packages/pi-prompt-magazine   # from this repo
pi install /absolute/path/to/pi-prompt-magazine
```

Start a new session (or `/reload`). Remove with:

```bash
pi remove pi-prompt-magazine
```

## Capture with `;;`

Type a multi-line draft and end the last line with `;;`, then press Enter:

```text
fix the typo in README
add tests for PR #42
;;
```

The marker must be at the end (trailing whitespace is tolerated). A marker in
the middle of a draft does nothing; bare `;;` is ignored. To send literal
trailing `;;`, use `;;;` (one semicolon is stripped). Only interactive
submissions are intercepted; RPC, script, and extension-injected inputs pass
through. The marker constant is `STASH_MARKER` in `magazine.ts`. A captured
draft is removed from the editor and the queue size is notified.

## Commands and UI

| Command | Action |
| --- | --- |
| `/magazine <n>` | Pop draft N into the editor (`/magazine 1` is the front). |
| `/magazine` | Browse, restore, peek, delete, reorder, or clear the queue. |
| `/magazine-clear` | Clear all after confirmation. |
| `/stash <text>` | Programmatic/script entry point. |

The browser lists `▸ #1 <preview>` through `#N <preview>` and offers **Restore
to editor**, Peek full text, Move up, Move down, Delete, Back, and Clear all.
Pops replace the current editor content. After restoring, append `;;` and
submit to put the draft back at the queue's end.

A non-empty widget above the prompt bar shows the count and one preview per
stash, up to 8 rows (`… N more` beyond that), refreshing after every change.

## Behavior and persistence

- Stashes append to the back; restore pops the selected item. Capacity is 50;
  pushing past it drops the oldest draft and reports the drop.
- State is per-session and follows restart, `/resume`, and session-tree
  navigation through custom `pi.appendEntry` entries (`customType:
  "pi-prompt-magazine"`). These entries do not reach the LLM or token
  accounting, and sessions are independent.
- Mutations use compact `add`/`remove`/`move`/`clear` op records, with a snapshot
  anchor every 25 mutations; legacy full-snapshot payloads still load. For
  realistic long-lived queues this grows the session file about 10x slower than
  full-snapshot persistence.
- Stashes are text-only: pasted images are not preserved because the extension
  cannot access the built-in editor paste snapshots. Pi's Ctrl+S stash remains a
  separate single-slot stash; a second stash is refused.

## Development and versioning

```bash
cd packages/pi-prompt-magazine
npm install        # installs typecheck deps from the published pi packages
npm run check      # strict typecheck
npm test           # typecheck + pure-model unit tests
```

Each change bumps the package version and adds a dated `Changelog.md` entry.

MIT
