# Third-party notices

## pi-clm

- Source: https://github.com/lolipopshock/pi-clm
- Version/tag: 1.0.0
- Commit: `b84a9d7cbb625cd39539db3bcef72ea9cc89aa89`
- Copyright: 2026 Emanuel Casco
- License: MIT. Original text is preserved in [LICENSE](LICENSE).

Vendored files are the upstream entry point, `src/` including its tests,
`steering/`, `docs/`, TypeScript configuration, license and README.
The original README is named `UPSTREAM_README.md`.
Upstream repository tooling, lockfile and screenshot assets were not imported.

Local changes:

- The entry point installs hash-only diagnostics after the upstream CLM factory.
- New `src/continuity-placement.ts`, `src/diagnostics.ts` and `src/diagnostic-fingerprint.ts`.
- `src/index.ts` inserts managed continuity at a stable projection boundary instead of each new tail, including context-view reconstruction. Synthetic note timestamps are deterministic.
- The upstream extension-test fixture disables diagnostics to avoid real trace files and adds continuity prefix/resume/branch regression tests.
- Local diagnostic tests, package manifest/lock, private README, changelog and
  notices; the TypeScript include list also checks local tests.

Continuity placement is changed. Projection/editing/budget/overflow/state algorithms and schemas are unchanged. The rejected experimental reasoning-stripping policy from local ren.2 was removed in ren.3.
Future updates should compare these explicit local changes against the pinned
upstream commit, not silently replace the source with a branch tip.
