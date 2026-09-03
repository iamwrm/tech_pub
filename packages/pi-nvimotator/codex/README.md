# codex-nvimotator

Codex Agent Skills and file-store CLI that give `$nvim-last` and `$nvim-annotate`
the same Neovim annotation surface as the Pi and Claude Code packages. The CLI
**exports a snapshot to a file and exits immediately**. Neovim Send writes
wrapped feedback to another file. `nvimotator last` / `import` print that
annotation path; the model Reads the file. The CLI does not block on Neovim
and does not dump the annotation body on stdout.

Codex has no Claude-style `/plugin` marketplace, and this package does not
invent one. Codex CLI 0.150+ exposes `codex plugin marketplace`; nvimotator
does **not** register there. Install the skills under `~/.agents/skills` (or a
repo `.agents/skills`) and invoke them as `$nvim-last` / `$nvim-annotate <path>`
/ `$nvim-import`, or run the CLI from the TUI as `!nvimotator export`.

The annotation UI is **Neovim**, not Plannotator's browser. Lua stays in
the parent `packages/pi-nvimotator` package root; this folder does not fork a
second UI and does not write `hooks.json` (Stop / plan review is out of scope).

## Install

Build the CLI, then install skills with the **absolute** binary path baked in
(Codex Desktop may not inherit `PATH`):

```bash
cd /absolute/path/to/tech_pub/packages/pi-nvimotator
npm ci && npm run build
chmod +x codex/bin/nvimotator codex/scripts/install-skills.sh
./codex/scripts/install-skills.sh
```

That writes `~/.agents/skills/nvim-last`, `nvim-annotate`, and `nvim-import`.
Repo-local skills:

```bash
./codex/scripts/install-skills.sh --repo
```

Restart Codex so it rescan skills. Confirm with the skill picker (`$`).

### Neovim plugin (kickstart.nvim)

This host reuses the Pi Neovim plugin. Put **the parent package root** on
`runtimepath` (not this `codex/` folder).

```lua
-- ~/.config/nvim/lua/custom/plugins/pi-nvimotator.lua
vim.opt.runtimepath:prepend '/absolute/path/to/tech_pub/packages/pi-nvimotator'
```

Uncomment `require 'custom.plugins'` in kickstart `init.lua` if needed, then
restart Neovim.

## Commands

Stdout is always **one absolute path**. stderr may print `Nvimotator 42` and
`nvim -c 'NvimotatorAttach 42'`. IDs recycle in 1–99 until Send, cancel, or a
~24h TTL. After `import <id>` the slot may be overwritten. `last` is a stable
copy at `~/.nvimotator/last/annotation.md` and is not a rotating id.

Override the file store for tests with `NVIMOTATOR_STORE` (owner-only
directory). This is separate from Pi's live-socket `PI_NVIMOTATOR_REGISTRY`.

### `$nvim-last` / `!nvimotator export`

Do not send a chat preamble first — that preamble can become the message being
annotated. Prefer the TUI bang form when you want the CLI to start immediately:

```text
!/absolute/path/to/tech_pub/packages/pi-nvimotator/codex/bin/nvimotator export
```

The CLI:

1. Discovers the current Codex rollout (`CODEX_THREAD_ID`, then
   `session_meta.cwd` under `$CODEX_HOME/sessions/YYYY/MM/DD/`, then the newest
   `rollout-*.jsonl`). `$CODEX_HOME` falls back to `~/.codex`.
2. Snapshots the latest **rendered** assistant `output_text`. An in-progress
   turn (for example the `$nvim-last` skill itself) is skipped so the previous
   completed reply is annotated.
3. Writes `~/.nvimotator/<id>/snapshot.md` and prints that absolute path on
   stdout. stderr has the locator. Then it **exits**.

After Send, run `$nvim-import` or `nvimotator last` and **Read** the printed
annotation path.

### `$nvim-annotate <path>` / `!nvimotator annotate <path>`

Same file-store export for a **local** file. Allowlist matches Pi nvimotator.

### `$nvim-import` / `!nvimotator last`

Prints the stable last-sent annotation path. `import <id>` prints a slot's
annotation path and frees that id.

## Versus Plannotator Codex

| | nvimotator | Plannotator Codex |
| --- | --- | --- |
| Last message | Neovim + file-store CLI | Browser UI |
| Local file | Neovim, local files only | Browser; also URL / Jina / live HTML |
| Plan review / Stop hook | **Out of scope** — this package does **not** write `hooks.json` | Experimental `Stop` hook after a plan turn |
| Marketplace | None. Skills + `!` only. | Installer + `~/.agents/skills` |
| Feedback wrap | Same local instruction wrap as Pi/Claude | `@plannotator/pi-extension` generated templates |

Pi `/nvim-last` still uses the live Unix-socket bridge. Claude Code uses this
same file-store CLI via `packages/pi-nvimotator/claude`.

## Development

```bash
cd packages/pi-nvimotator
npm ci
npm test
```

`npm test` covers the shared file store, Pi live bridge, and this Codex host.
