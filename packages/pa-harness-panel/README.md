# pa-harness-panel

Prime Agent extension for skimming the **current continual-harness state** —
the prompt notes, memories, skills, and subagent specs plus the refinement
history that `/refine` maintains — rendered from the raw `harness_state.json`
files into a browsable, searchable view.

Read-only by design: harness edits stay with `/refine` (which owns
serialization, rollback via `harnessStatePath`, and system-prompt rebuild).

Lifecycle ownership: [`IV-0012`](../../docs/IV-DC/IV-0012-prime-agent-harness-panel.md).

## Install

```bash
prime-agent package install ./packages/pa-harness-panel
```

Path-referenced from `~/.prime/agent/settings.json` (`packages` entry), so repo
edits apply immediately. Extensions load at session start; run `/reload` in an
already-open session to pick them up.

## Commands

| Command | Effect |
|---|---|
| `/harness [filter]` | open the interactive harness browser (widget strip + dialogs); optional filter pre-fills the search |
| `/harness text` | print a readable text report into the transcript (also the non-TUI fallback) |
| `/harness raw` | dump the merged raw JSON into the transcript |

## How it works

prime-agent 0.7.0 runs extension commands in the **session worker**, whose RPC
UI bridge supports only dialogs (`select`/`confirm`/`input`/`editor`), `notify`,
`setStatus`, `setWidget` (string lines), and `setTitle` — `ctx.ui.custom`
overlays are a no-op there. The extension therefore ships two experiences:

1. **Dialog browser (primary, every host)** — `/harness` shows a live summary
   strip above the editor (counts per kind/scope, current view, filter) and a
   select dialog listing the entries (or refinements, or raw JSON lines).
   `Enter` on a row opens the full record in an in-panel multi-line preview
   editor (scrollable, nothing imported into the session). Importing into the
   transcript is the explicit, rare action: after a preview, the `[e] expand
   last previewed in transcript` action renders it as a framed
   `[harness_report]` message (id, scope, version, timestamps, full content,
   skill `reference`/`arguments` contract, refinement
   rationale/evidence/outcome/applied edits). Raw-view rows also preview on
   `Enter` instead of dumping. Action rows switch view (`[1]/[2]/[3]`), set a
   filter (`[/]`), refresh from disk (`[r]`), dump the raw JSON (`[raw]`),
   print the text report (`[text]`), or close (`[q]`); Esc/Ctrl+C also closes
   and clears the widget.
2. **Overlay panel (premium)** — when the host actually implements
   `ctx.ui.custom` (in-process SDK hosts with local extension binding), the
   full-screen `HarnessPanel` overlay opens instead: keyboard-navigable
   entries/refinements/raw views, `Enter` expand, `/` filter, `r` refresh,
   live 2s tick, `q`/Esc close. The factory is only used if the platform
   invokes it; otherwise the browser takes over automatically.

## Data model

Mirrors prime-agent's `dist/core/refinement/refinement.js` semantics:

- global store: `<agentDir>/harness/harness_state.json` + `refinements.jsonl`
- local store: `<agentDir>/session-artifacts/<sessionId>/harness/harness_state.json`
  (session artifact dir comes from `sessionManager.getSessionArtifactDir()`,
  falling back to the sibling-of-session-dir convention)
- merged view: global overlaid with local; on id collision the local entry is
  re-keyed `local:<id>` (`mergeHarnessStates`) — collisions appear in the
  browser as separate `local` and `global` rows
- refinements: full records from `refinements.jsonl` + the session's
  `prime-agent.refinement` custom entries, de-duped by id (session wins); the
  compact `refinements` array in `harness_state.json` is the fallback
- corrupt/missing state files degrade to an empty store, never throw

## Hooks

`refine_complete` — an open overlay panel re-reads and re-renders immediately
when `/refine` applies edits.

## Known limits

- Read-only: no edit/delete actions in the panel (use `/refine`).
- Shows the *current session's* local store merged with global; other
  sessions' harness dirs are not browsable yet.
- Transcript reports render immediately only when the session is idle
  (`ctx.isIdle()`); while the model is streaming they queue to the next turn
  so the panel never steers the model.
- The full-screen overlay requires a host with working `ctx.ui.custom`
  (unavailable in prime-agent 0.7.0 CLI workers — the dialog browser is used
  there).

## Tests

```bash
cd packages/pa-harness-panel && npm install && npm run check && npm test
```

Zero-runtime-dep `node:test` (Node ≥22 type stripping): load/merge
normalization, `local:` collision prefixing, refinement merge/de-dupe,
real-file collection + mtime tracking, width-contract render assertions
(`visibleWidth`), keyboard flows, wrap spacing preservation, JSON coloring
round-trip, and the dialog-browser state machine (view switch, filter, expand,
close, widget lifecycle).
