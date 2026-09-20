# Changelog

## 0.4.2 — 2026-09-15

- Compact the hash-only sources: drop leftover multi-mode helpers and restated
  comments, flatten tests into `edit.test.ts` at the package root, and keep
  the two runtime modules unmerged. No hash notation or prompt change.

## 0.4.1 — 2026-09-15

- Keep the two runtime modules at the package root. Rename leftover
  `tests/hash-mode.test.ts` to `tests/hash.test.ts` and document that
  layout in the README and IV-0022. No runtime or prompt change.

## 0.4.0 — 2026-09-07

- Keep only hash edits. Remove `PI_UNIFIED_EDIT_MODE` selection, rows, patch,
  code execution, pi-JSON, their prompts, parsers, and dialect-only tests.
- Feed hash changes directly to one transaction writer and preview path;
  share the change type and remove the mode-bearing plan wrapper.
- Keep snapshot/seen-line validation, queued preflight, guarded rollback,
  UTF-8 checks, and hash prompt guidance. Add hash-only migration and
  deterministic rollback regressions, including concurrent-writer protection.
- Replace multi-mode docs with a hash reference and maintenance guide. Remove
  the historical matrix/token analyzers and omit tests/scripts from packaging.
- **Migration:** remove old mode environment settings and reload. All sessions
  now receive hash-tagged reads; old dialect payloads are rejected. Use Pi's
  `write` tool for new files.

## Earlier releases

- **0.3.0 (2026-08-17):** made hash the default after the five-mode comparison.
- **0.2.0 (2026-08-15):** added OMP-compatible hash notation, exact session
  snapshots, seen-line checks, and multi-file PUT/CUT/REM/MV planning.
- **0.1.x (2026-08):** vendored the original extension, hardened UTF-8 and
  transaction behavior, stabilized previews, and added dialect experiments.

Detailed historical notes and retired benchmark scripts are preserved at
[the last multi-mode revision](https://github.com/iamwrm/piagent-config/tree/7f0997c40d3061126d59a639eba8a677bd3aeca7/packages/pi-unified-edit).
