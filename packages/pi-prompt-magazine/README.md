# pi-prompt-magazine

Pi extension that turns the single-slot prompt stash into a persistent FIFO
queue. End a draft with `;;` instead of sending it, then browse and restore any
queued draft.

## Install

This package uses the native `better-sqlite3` runtime dependency. Register the
local checkout directly:

```bash
pi install ./packages/pi-prompt-magazine
```

On the first persisted session startup (including `/reload`), the extension
automatically installs missing dependencies, then opens SQLite without another
restart. Pi's local-path installer itself still only registers the path.
`--no-session` stays in memory and never installs dependencies.

The bootstrap runs `npm install --omit=dev --no-audit --no-fund --save=false`
**in the extension directory**, using npm on PATH. It reads the existing lockfile
when present without saving manifest/lockfile changes. This production install
may prune local dev dependencies; run `npm ci` before development/testing.
It can download packages/native binaries and execute dependency build scripts
with your account's permissions. npm must be available and the directory writable.
Prebuilt binaries depend on Node/platform availability; otherwise Python and a
C++ build toolchain may be required. Package metadata admits Linux/macOS/Windows
on x64/arm64.

Set `PI_PROMPT_MAGAZINE_AUTO_INSTALL=0` before starting Pi to disable automatic
installation (recommended for offline or externally managed deployments).
You can instead run `npm --prefix ./packages/pi-prompt-magazine ci` yourself.

Installation output is captured, not written over the TUI; errors include a
bounded diagnostic tail. npm has a three-minute timeout and is cancelled during
session teardown. A package-local `.pi-magazine-install.lock/` serializes Pi
installers; lock waits time out after 185 seconds. Crashed-process locks are not
automatically stolen: verify no installation is running before removing a stale
lock directory. This lock does not coordinate manual npm commands.

Existing but broken native/transitive dependencies and database errors do **not**
trigger automatic reinstalls. Repair those explicitly (for a Node ABI change,
try `npm rebuild better-sqlite3` in the package directory), then `/reload`.
While initialization is pending or failed, interactive `;;` drafts remain
handled and restored to the editor rather than sent to the model. The bootstrap
never deletes or resets the magazine database.

Start a new session or run `/reload`. Remove with:

```bash
pi remove pi-prompt-magazine
```

## Capture with `;;`

Type a multi-line draft and end its last line with `;;`, then press Enter:

```text
fix the typo in README
add tests for PR #42
;;
```

The draft is committed to SQLite before the editor is cleared or success is
reported. The marker must be at the end; trailing whitespace is tolerated. A
marker in the middle does nothing. Submit bare `;;` (surrounding whitespace is
allowed) to open the same browser as `/magazine`. Use `;;;` to send a literal
trailing `;;` (one semicolon is stripped).

Only interactive submissions in Pi's TUI are intercepted. Print-mode, RPC,
script, and extension-injected inputs pass through. If persistence fails, the
submission is handled rather than sent accidentally, its original text is
restored to the editor, and an error is shown.

## Commands and UI

| Command | Action |
| --- | --- |
| `/magazine <n>` | Pop draft N into the editor (`/magazine 1` is the front). |
| `/magazine` | Browse, restore, peek, delete, reorder, or clear the queue. |
| `/magazine-clear` | Clear the current session's queue after confirmation. |
| `/magazine-recover` | Recover an orphaned same-directory queue into an empty current queue. |
| `/stash <text>` | Programmatic/script entry point. |

The browser lists `▸ #1 <preview>` through `#N <preview>` and offers **Restore
to editor**, Peek full text, **Enter order mode**, Delete, Back, and Clear all.
Pops replace the current editor content. Add `;;` and submit again to return a
restored draft to the queue's end.

Order mode starts with the chosen draft grabbed. While grabbed, **↑/↓** moves
it and persists each step immediately; **Enter** releases it. Once released,
**↑/↓** moves the cursor and **Enter** grabs another draft. **Esc** finishes
without undoing already committed moves. The list follows stable draft IDs, so
if another Pi process removes the grabbed draft, the grab is released safely
instead of moving whichever row replaced it.

A non-empty widget above the prompt bar shows the count and up to eight draft
previews. Preview text has terminal control bytes removed. A one-second
revision check refreshes the widget if another Pi process commits a change to
the same magazine.

## SQLite persistence

The default database is:

```text
~/.pi/agent/pi-prompt-magazine.sqlite3
```

The path follows Pi's `PI_CODING_AGENT_DIR` override. The database file is
created owner-only where POSIX permissions are available. SQLite runs in WAL
mode with full synchronous durability and one `BEGIN IMMEDIATE` transaction per
mutation. Ordinary operations wait at most 250 ms for a lock so the synchronous
TUI cannot freeze for seconds; first-open WAL/schema setup retries contention
for up to five seconds.

One row is keyed by normalized working directory plus Pi's session ID. This
prevents a user-selected session ID from colliding across projects. Queue state
is therefore:

- restored after `/reload`, process restart, and `/resume` of the same session;
- independent between `/new` sessions;
- copied once by `/fork` and `/clone`, after which parent and child diverge;
- session-scoped rather than transcript-branch-scoped, so `/tree` does not
  rewind or replace the magazine.

`pi --no-session` never opens SQLite. Its queue remains in memory, with a
process-local handoff across `/reload` and an in-memory fork; it does not survive
a Pi process restart.

Every mutation rereads the row while holding its write transaction. Multiple
connections therefore cannot overwrite one another with stale in-memory
snapshots. Browser mutations also target stable stash IDs rather than stale
screen positions. SQLite protects magazine writes; it does **not** make Pi's
own JSONL conversation file safe for simultaneous writers.

The queue cap remains 50. Since a queue is small, SQLite stores one complete
JSON snapshot per session rather than an ever-growing operation log.

### Historical session entries and database versions

Historical `pi-prompt-magazine` custom entries may remain in Pi session JSONL
files. They are ignored: the extension neither parses nor replays them. SQLite
schema v2 is the only supported persisted format; the completed schema-v1
migration code has been removed. An unexpected database schema fails closed
instead of being reset.

### Orphan recovery

Pi does not create a new session's JSONL file until it contains an assistant
message. SQLite can still durably save a stash made before that point, but Pi
may have no session file to offer through `/resume` after a restart.

`/magazine-recover` lists non-empty queues from the same working directory
whose recorded Pi session file does not exist. Recovery is explicit, requires
an empty current queue, and atomically transfers the selected drafts. Before
committing, it verifies that the source revision has not changed and that its
session file is still absent; a concurrent source or target change cancels
recovery without overwriting either side. This also helps after a session file
was deleted. A currently running, not-yet-written session can look orphaned, so
never recover an entry you do not recognize.

## Limitations

- Stashes are text-only. Pasted images are not preserved because the extension
  cannot access Pi's built-in editor paste snapshots.
- Pi's built-in Ctrl+S stash remains a separate single-slot stash.
- Database rows are not automatically deleted when old Pi sessions are removed;
  clear or recover sensitive drafts explicitly.

## Development

```bash
cd packages/pi-prompt-magazine
npm install
npm run check
npm test
npm pack --dry-run
```

MIT
