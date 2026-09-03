# Third-party notices

## pi-nvimotator

Bridge, protocol, file allowlist, file store, feedback wrapping, and the
Neovim plugin live in the sibling `packages/pi-nvimotator` package. See that
package's LICENSE and THIRD_PARTY_NOTICES.

## Plannotator

Claude Code transcript discovery tiers follow the approach documented in
[backnotprop/plannotator](https://github.com/backnotprop/plannotator)
(`apps/hook/server/session-log.ts`): ancestor-PID session metadata, cwd
metadata scan, project-slug mtime, and ancestor-directory walk. Quick-action
labels follow the same prior art as pi-nvimotator. Plannotator is not a runtime
dependency of this package; its generated prompt templates are not copied here.
Plannotator is Copyright its contributors and is distributed under
`MIT OR Apache-2.0`.
