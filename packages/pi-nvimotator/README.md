# pi-nvimotator

Private, path-installed Pi extension plus dependency-free Neovim plugin for
annotating the latest assistant response or a local file. Run `/nvim-last` or
`/nvim-annotate <path>`, attach to the small numeric ID from any same-host
shell, then send structured line/selection feedback or copy the exact same
Plannotator-wrapped prompt.

## Requirements

- Pi 0.84.3 or newer
- Node.js 22.19 or newer
- Neovim 0.10 or newer. Current kickstart.nvim uses `vim.pack` and needs 0.12.
- Linux, macOS, or another POSIX host with Unix-domain sockets. Native Windows
  is rejected rather than falling back to a host-wide TCP listener.
- Same machine and OS account for Pi and Neovim
- `git` and `make` (kickstart clones plugins and builds `telescope-fzf-native`)

## Install

If you are starting from scratch, do these in order: mise, Neovim 0.12, latest
kickstart.nvim, then this package. The Pi extension creates an owner-only Unix
socket. The Neovim plugin provides `:NvimotatorAttach`, `<leader>nt`, and the
annotation UI.

### 1. Install mise

Official installer: https://mise.jdx.dev/installing-mise.html

```bash
curl https://mise.run | sh
```

Activate it in your shell. For zsh:

```bash
echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc
source ~/.zshrc
```

Bash uses `mise activate bash` and `~/.bashrc`. Fish uses `mise activate fish`
and `~/.config/fish/config.fish`.

### 2. Install Neovim

```bash
mise use -g neovim@0.12
nvim --version
```

`neovim@0.12` tracks the current 0.12.x. Pin a patch if you want one, for
example `neovim@0.12.5`.

### 3. Install latest kickstart.nvim

Backup any existing config, then clone upstream:

```bash
mv ~/.config/nvim ~/.config/nvim.bak
git clone https://github.com/nvim-lua/kickstart.nvim.git "${XDG_CONFIG_HOME:-$HOME/.config}/nvim"
nvim
```

The first launch installs plugins with `vim.pack`. Quit after it finishes.

If `git clone` hangs inside Neovim, a GitHub `gh auth git-credential` helper
can block non-TTY clones. Start `nvim` in a real terminal, or:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= nvim
```

### 4. Install the Pi extension

A local Pi path install does not install npm dependencies, so install them
first, then register the package with Pi:

```bash
cd /absolute/path/to/tech_pub/packages/pi-nvimotator
npm ci
cd /absolute/path/to/tech_pub
pi install ./packages/pi-nvimotator
```

### 5. Load the Neovim plugin on kickstart

The plugin is a normal `plugin/` plus `lua/` tree. Put the package root on
Neovim's runtimepath. `vim.pack` only clones git URIs, so a local path plugin
cannot go through `vim.pack.add`.

Create `~/.config/nvim/lua/custom/plugins/pi-nvimotator.lua`:

```lua
vim.opt.runtimepath:prepend '/absolute/path/to/tech_pub/packages/pi-nvimotator'
```

If `require 'custom.plugins'` is still commented in `init.lua`, uncomment it.
Restart Neovim.

### Already using lazy.nvim or LazyVim

Skip the kickstart clone. Create `~/.config/nvim/lua/plugins/pi-nvimotator.lua`:

```lua
return {
  {
    name = "pi-nvimotator",
    dir = "/absolute/path/to/tech_pub/packages/pi-nvimotator",
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

### Latest assistant message

In Pi:

```text
/nvim-last
```

Pi reports a numeric locator and the normal Neovim attach command, for example:

```text
Nvimotator ready (16)
nvim -c 'NvimotatorAttach 16'
```

### Local file

In Pi, pass a local markdown, text, config, HTML, or source file (or a folder
to pick one such file):

```text
/nvim-annotate README.md
```

Pi reports the same style of locator. File annotation stays in Neovim; it does
not open Plannotator's browser, fetch URLs, or launch a live app.

```text
Nvimotator ready (16)
File: /absolute/path/to/README.md
nvim -c 'NvimotatorAttach 16'
```

Run the attach command from any directory on the same host. The Neovim
installation above makes `:NvimotatorAttach` available, and the command opens
the captured assistant message or file as an immutable scratch buffer.

| Neovim command or mapping | Action |
| --- | --- |
| `:NvimotatorAttach <id>` | Attach by explicit numeric locator without inspecting or changing cwd. |
| `<leader>nt` | Prompt for a numeric locator and attach without leaving Neovim. |
| `:[range]NvimotatorAnnotate` | Add a free-form comment to the current line or Ex range. |
| `:[range]NvimotatorQuick` | Add `Deletion`, `Looks good`, or one of Plannotator's ten default quick labels to the current line/range. |
| `:NvimotatorComment` | Add an unanchored general comment. |
| `:NvimotatorComments` | Browse, jump to, edit, delete, export, send, or clear all pending feedback. |
| `:NvimotatorExport` | Copy the exact rendered feedback prompt to the `+` clipboard register. |
| `:NvimotatorSend` | Schedule feedback in the originating Pi session and close the bridge. |
| `:NvimotatorClear` | Confirm and clear this snapshot's pending annotations. |

Comments open in a rounded multiline Markdown editor below the selected line,
at that line's current position in the window rather than scrolling it to the
top. Temporary blank virtual lines displace the following source rows, so the
float covers no source text while snapshot bytes and annotation line numbers
remain unchanged. The editor is a normal `buftype=nofile` scratch buffer, so insert,
normal, visual, and default Vim keys work, including terminal Ctrl-V / bracketed
paste. Press `<C-s>` in normal or insert mode to save; press `<C-c>` to cancel.
`<Esc>` and `<C-[>` do not close the popup: insert Esc leaves insert, and
normal Esc is a no-op.

The quick-action picker mirrors Plannotator's direct **Deletion** and **👍 Looks
good** actions. It then lists Plannotator's exact ten default quick labels:
**❓ Clarify this**, **🗺️ Missing overview**, **🔍 Verify this**, **🔬 Give me an
example**, **🧬 Match existing patterns**, **🔄 Consider alternatives**, **📉
Ensure no regression**, **🚫 Out of scope**, **🧪 Needs tests**, and **👍 Nice
approach**. The picker shows these compact labels only; their agent-facing tips
remain part of exported and sent feedback. IDs, ordering, labels, and tips follow
Plannotator's [`quickLabels.ts`](https://github.com/backnotprop/plannotator/blob/main/packages/ui/utils/quickLabels.ts).

Attachment input, quick actions, annotation browsing, per-annotation actions,
and clear confirmation use the same non-overlapping owned modal layout. Pickers
support typing a prefix to filter labels (case-insensitive; a leading emoji is
ignored, so `L` leaves **Looks good**), `j`/`k`, arrow keys, `<Enter>` to select,
and `q` or `<C-c>` to cancel.
`<Esc>` does not close pickers. Cancel does not record an annotation. In a window
too small to reserve a bordered float, or when the target line cannot be located
on screen after displacement, the modal falls back to a temporary split rather
than covering text.

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
| Normal | `<leader>nt` | Prompt for a numeric locator and attach. |
| Normal/visual | `<leader>na` | Free-form annotation |
| Normal/visual | `<leader>nq` | Quick action |
| Normal | `<leader>ng` | Add an unanchored global comment |
| Normal | `<leader>nc` | Comments overview |
| Normal | `<leader>ns` | Send |

Set `vim.g.pi_nvimotator_disable_default_mappings = true` before plugin load to
use only the provided `<Plug>` mappings.

Characterwise and linewise visual selections are supported. Blockwise visual
mode is deliberately rejected.

## Semantics and limits

- `/nvim-last` waits for Pi to settle and snapshots the latest non-empty
  assistant message on the active branch. Running it again refreshes the
  snapshot while preserving the live bridge locator.
- `/nvim-annotate <path>` snapshots a local file onto the same bridge. Allowed
  types match Plannotator annotate documents (`.md`, `.mdx`, `.txt`, YAML/JSON
  /TOML/HTML and similar) and, broader than Plannotator annotate, source files
  such as `.ts` and `.lua`. Files must be 2 MiB or smaller. Bare `.env` files
  and key material are rejected. A directory lists immediate annotatable files
  and picks one; there is no folder browser. URLs, Jina, live `--app`/`--static`
  HTML, plan-mode, `/plannotator-review` diffs, and Approve/gate are out of
  scope.
- The Pi process must remain open. Reload, new/resumed/forked sessions, or exit
  close the bridge.
- Last-message feedback uses Plannotator's configured
  `prompts.annotate.messageFeedback` template. File feedback uses
  `prompts.annotate.fileFeedback`, includes the file path, and is marked as a
  file/document annotation rather than last-assistant-message feedback. Export
  freezes the rendered bytes; a later Send of the unchanged annotations
  schedules those exact bytes.
- A successful bridge acknowledgement means Pi accepted the synchronous
  scheduling call. Pi's public API does not prove durable transcript
  persistence, and deduplication lasts only for the live bridge.
- The transport uses an authenticated Unix-domain socket inside the owner-only
  registry directory. The directory is mode `0700`; manifests and sockets are
  mode `0600`. Other OS users cannot traverse to or connect to the socket. Root
  and processes running as the same UID remain inside the trust boundary. The
  numeric locator is not a secret. Authentication tokens never enter buffers,
  drafts, clipboard output, or notifications.
- Modal displacement uses display-only extmarks and restores the source view
  and cursor on save, cancel, window close, or error. It never inserts buffer
  lines or changes feedback anchors.

Override the shared registry and Unix-socket directory for both processes with
an absolute, short, owner-only path:

```bash
export PI_NVIMOTATOR_REGISTRY="$HOME/.cache/pi-nvimotator/registry"
```

Unix socket paths have a platform byte limit. Nvimotator rejects paths over 100
bytes with an actionable error rather than silently falling back to TCP.

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
