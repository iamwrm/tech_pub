# Changelog

## [0.3.1] - 2026-08-15

- Rename the order-mode **Enter drop** hint to **Enter release** so it cannot
  be mistaken for deleting the grabbed draft.

## [0.3.0] - 2026-08-15

- Replace per-item **Move up** and **Move down** actions with a keyboard order
  mode: the chosen draft starts grabbed, arrows reorder, Enter drops/selects,
  and Esc finishes. Every move is committed immediately by stable draft ID.
- Treat bare `;;` (including surrounding whitespace) as the same browser action
  as `/magazine`, while retaining `text;;` stash and `text;;;` escape behavior.
- Add a width-safe, windowed custom TUI component plus component and extension
  tests for multi-entry reordering, reselection, concurrent deletion, and bare
  marker dispatch.

## [0.2.1] - 2026-08-15

- Remove the completed Pi custom-entry log importer and its parser/replayer;
  historical magazine entries in session JSONL files are now ignored.
- Remove the completed SQLite schema-v1 migration and support only schema v2.
  Unexpected schema versions fail closed without modifying stored queues.

## [0.2.0] - 2026-08-15

- Replace the Pi-session custom-entry op log as the authoritative store with a
  shared WAL-mode SQLite database at
  `~/.pi/agent/pi-prompt-magazine.sqlite3` (respecting
  `PI_CODING_AGENT_DIR`), keyed by normalized cwd plus Pi session ID.
- Make every queue mutation an immediate SQLite transaction that rereads the
  latest snapshot before writing. Add full synchronous durability, a 250 ms
  per-operation lock wait (with bounded five-second startup retries), stable-ID
  browser mutations, and revision polling so simultaneous Pi connections
  neither lose writes nor keep a stale widget.
- Restore the same queue across `/reload`, restart, and `/resume`; isolate
  `/new`; copy a parent's queue once for `/fork`/`/clone`; make `/tree`
  navigation intentionally keep the session-level queue rather than rewind it.
- Import historical `pi-prompt-magazine` custom-entry logs exactly once into
  SQLite. Empty rows remain as migration tombstones so clearing a queue cannot
  resurrect legacy drafts.
- Add `/magazine-recover` for explicit transfer of a same-directory orphaned
  queue when Pi never wrote (or later lost) its corresponding session file;
  revalidate the selected source and target after confirmation.
- Keep `--no-session` queues entirely in memory, including process-local reload
  and fork handoff, and recognize CLI forks through the session parent header.
- Fail safely when a stash cannot be committed: handle rather than submit the
  prompt, restore its original editor text, and report the storage error. Make
  notification, editor-handoff, clear-confirmation, and polling failures
  rollback-safe or self-defusing.
- Add the pinned `better-sqlite3` runtime dependency, SQLite storage/lifecycle
  suites, independent-process concurrency and crash-exit coverage, focused
  extension harness tests, supported native-platform metadata, and terminal
  control stripping for all previews.

## [0.1.2] - 2026-08-14

- Compress the README while preserving the operator contract; runtime behavior
  is unchanged.

## [0.1.1] - 2026-08-14

- Replace the stale link to the retired Prime Agent source package with an
  accurate historical provenance note. Runtime behavior is unchanged.

## [0.1.0] - 2026-08-11

- Initial `/magazine` pi extension, ported from the Prime Agent
  `pa-prompt-magazine` 0.2.0 package with the same command surface and
  semantics, fitted to the pi 0.84.1 API.
  - `;;` capture: end a submitted draft (multi-line OK) with `;;` to stash it
    into the magazine instead of sending; `;;;` escapes to a literal `;;`
    send; bare `;;` is ignored. pi's `input` event maps 1:1 (source
    `"interactive"` for editor submissions; RPC/script/extension inputs
    pass).
  - `/magazine <n>` pops the Nth draft directly into the editor; `/magazine`
    without an argument opens the queue browser (restore / peek / delete /
    move up/down / clear all); `/magazine-clear` clears with confirmation;
    `/stash <text>` is the programmatic entry point.
  - Live queue widget above the prompt bar (count + one preview row per
    stash, front entry marked ▸, up to 8 rows).
  - Per-session persistence via custom session entries (`pi.appendEntry`);
    op-log storage with snapshot anchors every 25 mutations; legacy
    full-snapshot payloads still load.
  - Add strict typechecking and the pure-model unit suite (FIFO semantics,
    cap dropping, marker parsing, op-log replay, defensive parsing).
