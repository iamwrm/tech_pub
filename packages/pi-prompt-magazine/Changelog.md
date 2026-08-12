# Changelog

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
