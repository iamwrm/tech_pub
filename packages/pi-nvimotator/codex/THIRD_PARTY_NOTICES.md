# Third-party notices

## pi-nvimotator

File store, file allowlist, feedback wrapping, generic file CLI, and the
Neovim plugin live in the sibling `packages/pi-nvimotator` package. See that
package's LICENSE and THIRD_PARTY_NOTICES.

## Plannotator

Codex rollout discovery follows the approach documented in
[backnotprop/plannotator](https://github.com/backnotprop/plannotator)
(`apps/hook/server/codex-session.ts`): `$CODEX_HOME` or `~/.codex`, dated
`sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl` files, `CODEX_THREAD_ID`, and
assistant `response_item` / `output_text` parsing. Quick-action labels follow
the same prior art as pi-nvimotator. Plannotator is not a runtime dependency
of this package; its generated prompt templates are not copied here.
Plannotator is Copyright its contributors and is distributed under
`MIT OR Apache-2.0`.
