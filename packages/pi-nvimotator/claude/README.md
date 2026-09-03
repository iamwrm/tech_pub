# claude-nvimotator

Claude Code plugin and file-store CLI that give `/nvim-last` and `/nvim-annotate`
the same Neovim annotation surface as the Pi package. The CLI **exports a
snapshot to a file and exits immediately**. Neovim Send writes wrapped feedback
to another file. `nvimotator last` / `import` print that annotation path; the
model Reads the file. The CLI does not block on Neovim and does not dump the
annotation body on stdout.

The annotation UI is **Neovim**, not Plannotator's browser. Lua stays in
the parent `packages/pi-nvimotator` package root (`lua/`, `plugin/`); this
folder does not fork a second UI.

## Install

Install is the marketplace or `--plugin-dir` path below. The plugin ships
`cli.bundle.js`, so you do not need `npm ci` to run `/nvim-last`. Rebuild the
bundle only when changing CLI sources:

```bash
cd /absolute/path/to/tech_pub/packages/pi-nvimotator && npm ci && npm run build
```

### Marketplace (this repository)

In Claude Code:

```text
/plugin marketplace add /absolute/path/to/tech_pub
/plugin install nvimotator@nvimotator
```

Private GitHub:

```text
/plugin marketplace add iamwrm/tech_pub
/plugin install nvimotator@nvimotator
```

Restart Claude Code so plugin `bin/` is on the Bash tool PATH. Confirm with
`/help` — `/nvim-last`, `/nvim-annotate`, and `/nvim-import` should appear
(from `commands/`). Plugin-namespaced aliases also work (from `skills/`).
Prefer the bare names when they are free.

### Local path (no marketplace)

```bash
claude --plugin-dir /absolute/path/to/tech_pub/packages/pi-nvimotator/claude
```

Or `/plugin` → add a local folder pointing at `packages/pi-nvimotator/claude`.

### Neovim plugin (kickstart.nvim)

This host reuses the Pi Neovim plugin. Put **the parent package root** on
`runtimepath` (not this `claude/` folder).

Create `~/.config/nvim/lua/custom/plugins/pi-nvimotator.lua`:

```lua
vim.opt.runtimepath:prepend '/absolute/path/to/tech_pub/packages/pi-nvimotator'
```

Uncomment `require 'custom.plugins'` in kickstart `init.lua` if needed, then
restart Neovim. lazy.nvim/LazyVim can use `dir = "/absolute/path/to/.../pi-nvimotator"`
with `lazy = false` instead.

## Commands

Stdout is always **one absolute path**. stderr may print `Nvimotator 42` and
`nvim -c 'NvimotatorAttach 42'`. IDs recycle in 1–99 until Send, cancel, or a
~24h TTL. After `import <id>` the slot may be overwritten. `last` is a stable
copy at `~/.nvimotator/last/annotation.md` and is not a rotating id.

Override the file store for tests with `NVIMOTATOR_STORE` (owner-only
directory). This is separate from Pi's live-socket `PI_NVIMOTATOR_REGISTRY`.

### `/nvim-last`

Do not send a chat preamble first — that preamble can become the message being
annotated.

Claude Code expands `/nvim-last` by running `nvimotator export` locally (`!`
injection) **before** any model call. The CLI:

1. Discovers the current Claude Code transcript (`CLAUDE_CODE_SESSION_ID` /
   `CLAUDE_SESSION_ID`, then `~/.claude/sessions/<pid>.json` ancestor walk,
   cwd metadata scan, project-slug mtime, ancestor directories).
2. Snapshots the latest **rendered** assistant text on the live conversation
   branch (`/rewind` orphans are skipped). An in-progress `/nvim-last` skill
   turn is not used as the snapshot target.
3. Writes `~/.nvimotator/<id>/snapshot.md` (directory `0700`, files `0600`) and
   prints that absolute path on stdout. stderr has the locator:

```text
Nvimotator 16
nvim -c 'NvimotatorAttach 16'
```

4. Exits. It does not wait for Neovim Send.

From any same-host shell:

```bash
nvim -c 'NvimotatorAttach 16'
```

After Send, run `/nvim-import` or `nvimotator last` and **Read** the printed
annotation path.

### `/nvim-annotate <path>`

`/nvim-annotate <path>` is the same local `!` injection for a **local** file.
Allowlist matches Pi nvimotator: markdown/text/config/HTML plus source (`.ts`,
`.lua`, …). 2 MiB cap. Rejects `.env` / key material. A folder with one
allowlisted file uses that file; a folder with several requires an explicit
file path (no folder browser).

### `/nvim-import`

Prints `~/.nvimotator/last/annotation.md` (or `import <id>` for a specific
sent slot). Read that file. `import <id>` frees the slot.

## Neovim UX

Unchanged from the Pi plugin: immutable scratch; comments; Quick Action prefix
filter (leading emoji stripped, so `L` → Looks good); insert Esc → normal,
normal Esc no-op, cancel `<C-c>`, comment submit `<C-s>`; float stays on the
target line (no `zt`); tiny-window split fallback.

`:NvimotatorSend` writes wrapped feedback to `annotation.md` and updates
`last/annotation.md`. `:NvimotatorCancel` frees the file-store slot. Pi live
Unix-socket attach still works for `/nvim-last` inside Pi.

## Versus Plannotator's Claude Code plugin

| | nvimotator | Plannotator Claude plugin |
| --- | --- | --- |
| Last message | Neovim + file-store CLI | Browser UI (`plannotator last`) |
| Local file | Neovim, local files only | Browser; also URL / Jina / live HTML |
| Plan review / `ExitPlanMode` | Out of scope | Hook + Approve/gate |
| `/plannotator-review` diffs | Out of scope | In scope |
| Feedback wrapping | Local instruction wrap (last message vs file path) | `@plannotator/pi-extension` generated templates |
| Host integration | Plugin + non-blocking file CLI + skills | Plugin hooks + blocking CLI + skills |

Pi `/nvim-last` and `/nvim-annotate` are unchanged. They still start a
non-blocking Unix-socket bridge inside a live Pi TUI session.

## Development

```bash
cd packages/pi-nvimotator
npm ci
npm test
```

`npm test` covers the shared file store, Pi live bridge, and this Claude host.
The plugin ships `claude/cli.bundle.js` (built by `npm run build`) so Claude Code can run `bin/nvimotator` without installing npm packages into the copied plugin directory.

Honors `CLAUDE_CONFIG_DIR` for transcript discovery and `NVIMOTATOR_STORE` for
the file store (default `~/.nvimotator`).
