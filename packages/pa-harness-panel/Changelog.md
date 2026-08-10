# Changelog

## 0.1.4 — 2026-08-09

- Compact browser rows: kind moved to a per-section header line
  (`── memory (2) ──`), scope badges shortened to `l`/`g`, and the reference
  key wrapped in brackets (`l [astro-task] v5 — Title — preview`). Refinement
  rows use the same style with a date. `[e]`/preview labels updated to match.

## 0.1.3 — 2026-08-09

- Browser rows now show an uppercase scope badge (`LOCAL`/`GLOBAL`) and the
  entry's reference key (id) so every entry is addressable for `/refine` edits
  or `rlm.harness` calls; previews show the merged `map key` line when a
  session entry collides with a global id (`local:` prefix). Text report rows
  include the id as well.

## 0.1.2 — 2026-08-09

- Dialog browser interaction change: `Enter` on a row now opens the in-panel
  preview directly (no intermediate detail menu); expanding into the
  transcript is the explicit, rare `[e] expand last previewed in transcript`
  action. Raw-view rows also preview instead of dumping.

## 0.1.1 — 2026-08-09

- Dialog browser: new `[p]` action opens the full record in an in-panel
  multi-line editor preview (entries, refinements, and raw JSON) without
  importing anything into the session transcript. `[enter]` remains the
  explicit transcript-import action.

## 0.1.0 — 2026-08-09

- Initial release: `/harness [filter|raw|text]` interactive TUI panel over the
  current continual-harness state (prompt/memory/skill/subagent entries +
  refinement history), with live refresh on `refine_complete`, non-TUI text
  report and raw JSON fallbacks, and zero-dependency unit tests.
