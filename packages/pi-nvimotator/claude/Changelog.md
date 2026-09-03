# Changelog

## 0.2.0

- Replaced the blocking Unix JSONL CLI with a file-store CLI. `export` /
  `annotate` write `~/.nvimotator/<id>/snapshot.md` and print that absolute
  path; they do not wait for Neovim. After Send, `last` / `import [id]` print
  the annotation path for the model to Read. IDs recycle in 1–99.
- Added `/nvim-import`. Skills tell the model to Read the printed path instead
  of treating stdout as wrapped feedback.
- Dropped `runBlockingBridge` on the Claude path.
- Renamed `src/session-log.ts` to `src/claude-session.ts` (and
  `tests/claude-session.test.ts`) to pair with Codex `codex-session.ts`.
- Nested this host at `packages/pi-nvimotator/claude/` (no separate
  `package.json`). Marketplace `source` is `./packages/pi-nvimotator/claude`.

## 0.1.0

- Initial Claude Code plugin, blocking `nvimotator last` / `nvimotator annotate`
  CLI, and `/nvim-last` / `/nvim-annotate` skills. Reuses the Pi nvimotator
  Unix bridge, JSONL protocol, file allowlist, local feedback wrapping, and
  Neovim Lua UI.
