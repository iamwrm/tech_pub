# Changelog

## [0.2.0] - 2026-08-09

- Reworked capture and storage.
  - **`;;` capture**: end a submitted draft (multi-line OK) with `;;` to stash it into the magazine instead of sending; `;;;` escapes to a literal `;;` send; bare `;;` is ignored; only interactive submissions are intercepted. Removed the Ctrl+S shortcuts (not dispatched in the daemon CLI) and the `/stash` editor dialog.
  - `/magazine <n>` pops the Nth draft directly into the editor; `/magazine` without an argument opens the queue browser (restore / peek / delete / move up/down / clear all).
  - `/stash <text>` remains as the programmatic entry point (scripts/RPC).
  - **Storage: op log instead of full snapshots.** Every mutation persists a compact op record (`add` / `remove` / `move` / `clear`), with a full snapshot anchor every 25 mutations; restore replays from the last anchor. ~10x less session-file growth for realistic queues (legacy full-snapshot payloads still load).
## [0.1.0] - 2026-08-09

- Initial release: multi-slot prompt stash queue ("magazine") for Prime Agent.
  - `/stash [text]` stashes a draft (dialog editor when no text is given).
  - `/magazine` interactive queue browser: restore to editor, peek full text, delete, move up/down, clear all.
  - `/magazine-clear` clears the queue with confirmation.
  - Live widget above the prompt bar: count + one preview row per stash.
  - `Ctrl+S` / `Ctrl+Shift+S` shortcuts for in-process hosts (SDK / `--no-session`).
  - Per-session persistence via custom session entries; FIFO with 50-draft cap (oldest dropped).
