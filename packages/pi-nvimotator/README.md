# pi-nvimotator

Private, path-installed Pi extension plus dependency-free Neovim plugin for
annotating the latest assistant response. Run `/nvim-last`, attach to its small
numeric ID from any same-host shell, then send structured line/selection
feedback or copy the exact same Plannotator-wrapped prompt.

Lifecycle and design: [`IV-0027`](../../docs/IV-DC/IV-0027-pi-nvimotator.md).

## Requirements

- Pi 0.84.3 or newer
- Node.js 22.19 or newer
- Neovim 0.10 or newer
- Same machine and OS account for Pi and Neovim

## Install

Install both halves: the Pi extension creates bridges, while the Neovim plugin
provides `:NvimotatorAttach` and the annotation UI.

### 1. Install in Pi

A local Pi path install does not install npm dependencies, so install them
first, then register the package with Pi:

```bash
cd /absolute/path/to/piagent-config/packages/pi-nvimotator
npm ci
cd /absolute/path/to/piagent-config
pi install ./packages/pi-nvimotator
```

### 2. Install in Neovim with lazy.nvim or LazyVim

Create `~/.config/nvim/lua/plugins/pi-nvimotator.lua`:

```lua
return {
  {
    name = "pi-nvimotator",
    dir = "/absolute/path/to/piagent-config/packages/pi-nvimotator",
    lazy = false,
  },
}
```

Use an absolute `dir`, then restart Neovim or run:

```vim
:Lazy sync
```

The plugin owns and safely refreshes its commands and `<Plug>` mappings, so
`:Lazy reload pi-nvimotator` is supported. Unrelated pre-existing commands or
`<Plug>` mappings with the same names are left untouched.

## Workflow

In Pi:

```text
/nvim-last
```

Pi reports a numeric locator and the normal Neovim attach command, for example:

```text
Nvimotator ready (16)
nvim -c 'NvimotatorAttach 16'
```

Run the command from any directory on the same host. The lazy.nvim/LazyVim
installation above makes `:NvimotatorAttach` available, and the command opens
the captured assistant message as an immutable Markdown scratch buffer.

| Neovim command | Action |
| --- | --- |
| `:NvimotatorAttach <id>` | Attach by explicit numeric locator without inspecting or changing cwd. |
| `:[range]NvimotatorAnnotate` | Add a free-form comment to the current line or Ex range. |
| `:[range]NvimotatorQuick` | Add `Deletion`, `Looks good`, or one of Plannotator's ten default quick labels to the current line/range. |
| `:NvimotatorComment` | Add an unanchored general comment. |
| `:NvimotatorComments` | Browse, jump to, edit, delete, export, send, or clear all pending feedback. |
| `:NvimotatorExport` | Copy the exact rendered feedback prompt to the `+` clipboard register. |
| `:NvimotatorSend` | Schedule feedback in the originating Pi session and close the bridge. |
| `:NvimotatorClear` | Confirm and clear this snapshot's pending annotations. |

Comments open in a rounded multiline Markdown editor, positioned below the
selected line when space permits. Press `<C-s>` in normal or insert mode to
save; press `<Esc>` or `<C-c>` to cancel.

The quick-action picker mirrors Plannotator's direct **Deletion** and **👍 Looks
good** actions. It then lists Plannotator's exact ten default quick labels:
**❓ Clarify this**, **🗺️ Missing overview**, **🔍 Verify this**, **🔬 Give me an
example**, **🧬 Match existing patterns**, **🔄 Consider alternatives**, **📉
Ensure no regression**, **🚫 Out of scope**, **🧪 Needs tests**, and **👍 Nice
approach**. The picker shows these compact labels only; their agent-facing tips
remain part of exported and sent feedback. IDs, ordering, labels, and tips follow
Plannotator's [`quickLabels.ts`](https://github.com/backnotprop/plannotator/blob/main/packages/ui/utils/quickLabels.ts).

Global comments render immediately as virtual lines above the first assistant
line. The panel shows a compact summary plus hints for `<leader>ng` (add) and
`<leader>nc` (manage). The comments overview includes **Clear all annotations…**,
which uses the same confirmation as `:NvimotatorClear`; the panel disappears
when the last global comment is removed. `virt_lines_above`, snapshot bytes, and
annotation line numbers do not change.
Themes can override `NvimotatorGlobalBorder`, `NvimotatorGlobalTitle`,
`NvimotatorGlobalComment`, and `NvimotatorGlobalHint`.

Default mappings are installed only when the left-hand side and matching
`<Plug>` target are unused:

| Mode | Mapping | Action |
| --- | --- | --- |
| Normal/visual | `<leader>na` | Free-form annotation |
| Normal/visual | `<leader>nq` | Quick action |
| Normal | `<leader>ng` | Add an unanchored global comment |
| Normal | `<leader>nc` | Comments overview |
| Normal | `<leader>ns` | Send |

Set `vim.g.pi_nvimotator_disable_default_mappings = true` before plugin load to
use only the provided `<Plug>` mappings.

Characterwise and linewise visual selections are supported. Blockwise visual
mode is deliberately rejected in 0.1.0.

## Semantics and limits

- `/nvim-last` waits for Pi to settle and snapshots the latest non-empty
  assistant message on the active branch. Running it again refreshes the
  snapshot while preserving the live bridge locator.
- The Pi process must remain open. Reload, new/resumed/forked sessions, or exit
  close the bridge.
- Feedback uses Plannotator's configured `prompts.annotate.messageFeedback`
  template. Export freezes the rendered bytes; a later Send of the unchanged
  annotations schedules those exact bytes.
- A successful bridge acknowledgement means Pi accepted the synchronous
  scheduling call. Pi's public API does not prove durable transcript
  persistence, and deduplication lasts only for the live bridge.
- The transport binds only `127.0.0.1`; registry and draft files are owner-only
  on POSIX. The numeric locator is not a secret. Authentication tokens never
  enter buffers, drafts, clipboard output, or notifications.

Override the shared registry directory for both processes with:

```bash
export PI_NVIMOTATOR_REGISTRY="$HOME/.cache/pi-nvimotator/registry"
```

## Development

```bash
cd packages/pi-nvimotator
npm ci
npm test
npm run test:e2e
npm pack --dry-run
```

`npm run test:e2e` uses isolated real Pi and Neovim processes in tmux with a
local deterministic fake provider; it makes no external model request.
