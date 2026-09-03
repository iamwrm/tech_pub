# Changelog

## Unreleased

- Removed unused live-bridge `blocking` snapshot flag and `cancel` request.
  `:NvimotatorCancel` on Pi still detaches locally; the bridge keeps running.
  `ping` is unchanged.
- Removed file-store CLI `complete`. Neovim Lua writes `annotation.md`.

## 0.4.0

- Added a generic file store (`~/.nvimotator/<id>/`, override `NVIMOTATOR_STORE`)
  and file-store CLI (`export` / `annotate` / `last` / `import`) for Claude Code
  and Codex. IDs recycle in 1–99. Neovim can attach by file-store id or
  `snapshot.md` path; Send writes `annotation.md` and a stable
  `last/annotation.md`. Pi `/nvim-last` still uses the live Unix-socket bridge.
- `:NvimotatorAttach` tries the live Pi registry first, then the file store.
- Nested `claude/` is the Claude Code marketplace plugin (file-store CLI);
  nested `codex/` is Codex skills + `!` only. `pi.extensions` is only
  `index.ts`; `pi install ./packages/pi-nvimotator` does not load those hosts.
- Package README leads with a Pi / Claude Code / Codex host map. `files`
  includes nested `claude/` and `codex/` so a path/pack of this package
  includes the hosts.

## 0.3.5

- Dropped the `@plannotator/pi-extension` runtime dependency. Export and Send
  wrap last-message and file feedback with a small local instruction block
  (Neovim annotation on the last assistant message or a local file; incorporate
  comments and quick actions). Quick-action labels remain Plannotator-inspired.
  `pi install ./packages/pi-nvimotator` no longer requires `npm ci` first.
- `:NvimotatorCancel` detaches locally on Pi; the host bridge keeps running.
  Send's acknowledgement no longer says "in Pi".
- Registry directories created in this process are chmod'd to `0700` after
  `mkdir`, so a typical umask of `0022` no longer leaves a new Unix-socket
  registry world-readable and then fail-closed. An existing too-open override
  is still rejected without chmod.

## 0.3.4

- Added `/nvim-annotate <path>`, a Neovim-side sibling of Plannotator's
  `/plannotator-annotate` that snapshots a local file onto the existing
  owner-only Unix bridge. Neovim still attaches with `:NvimotatorAttach`
  and reuses comment, Quick Action prefix filter, Export, and Send.
- File feedback is wrapped with Plannotator's `prompts.annotate.fileFeedback`
  (`getAnnotateFileFeedbackPrompt`), including the file path, and is marked as
  a file/document annotation rather than last-assistant-message feedback.
  `/nvim-last` is unchanged and still uses `messageFeedback`.
- Allowlist covers Plannotator annotate documents (markdown/text/config/HTML)
  plus source files (`.ts`, `.lua`, and similar). Rejects `.env`/key material,
  files over 2 MiB, URLs/Jina/live apps, and unreadable paths. A folder picks
  one allowlisted file; there is no folder browser.

## 0.3.3

- Owned floats open on the annotated/source line at its **current window row**
  instead of `zt`-pinning that line to the top of the window. Virtual lines
  still displace following source text so the float never covers it. If the
  line is too low for the bordered modal, the view scrolls only far enough
  for the float to fit; a line that still cannot be located falls back to the
  existing tiny-window split.

## 0.3.2

- Quick Action no longer treats picker cancel/`WinClosed` as a selected action.
  The in-place owned picker (`99dd901`) forwarded `nil` into `add_action`, which
  warned `Nvimotator quick action is invalid.` Restored the old `vim.ui.select`
  nil-guard, pass the source window and range end into the layout lease, leave
  visual before positioning, and fall back to the existing split when the
  displaced line cannot be located on screen.
- Owned pickers restore incremental prefix filtering (the in-place static list
  had dropped `vim.ui.select`/dressing type-to-filter). Typing letters matches
  `action.label` case-insensitively, ignoring a leading emoji so `L` leaves
  only **Looks good**. Backspace/`<C-h>`/`<C-u>` edit the query; Enter selects
  the filtered row's original action object; a non-matching prefix shows a
  placeholder and does not save. Footer hints `type to filter`.

## 0.3.1

- Comment and one-line input popups are ordinary `buftype=nofile` scratch
  buffers: `<Esc>` / `<C-[>` no longer cancel. Insert Esc leaves insert;
  normal Esc is a no-op. Cancel is `<C-c>`; comment save remains `<C-s>`.
  This stops Windows Terminal / Herdr Ctrl-V bracketed paste (CSI `200~`)
  from being swallowed by a `nowait` insert-mode Esc mapping.

## 0.3.0

- Added a shared displaced-window layout: temporary blank virtual lines move
  real source rows below every owned modal, so floats never cover source text
  without changing snapshot bytes or annotation line numbers.
- Replaced delegated `vim.ui.input`/`vim.ui.select` dialogs with owned input,
  picker, action, overview, and confirmation modals using the same layout.
- Added view/cursor restoration, idempotent extmark cleanup, source-window width
  bounds, a tiny-window split fallback, and headless/tmux geometry coverage.

## 0.2.0

- Replaced host-wide IPv4 loopback TCP with authenticated protocol-v2 Unix
  sockets inside the owner-private registry. Registry directories remain
  `0700`; manifests and sockets are `0600`; native Windows fails closed.
- Added `<leader>nt` and `<Plug>(NvimotatorAttach)` for prompted numeric-locator
  attachment from an existing Neovim session.
- Extended lifecycle and E2E coverage to socket permissions, path validation,
  cleanup races, hard-kill stale sockets, legacy protocol rejection, and the
  prompted mapping.
- README install path is now mise, Neovim 0.12, latest kickstart.nvim, then this
  package. lazy.nvim/LazyVim remains an alternative.

## 0.1.0

- Initial `/nvim-last` Pi bridge and same-host cross-cwd Neovim attachment.
- Immutable assistant-message buffer with line/visual comments and quick actions.
- Byte-identical Plannotator-wrapped clipboard export and Pi feedback scheduling.
- Owner-private registry, token-free drafts, retry-safe submission identity, and tmux E2E coverage.
- Rounded multiline comment editor adapted from `pi-nvim-review`, plus `<leader>ng` for global comments.
- Non-mutating virtual-line panel for immediate global-comment visibility.
- Comments overview now offers a confirmed **Clear all annotations…** action.
- Replaced generic Good/Bad actions with Plannotator's **Deletion**, **Looks good**, and exact ten default quick labels and tips.
- Made Neovim command and `<Plug>` registration reload-safe without overwriting unrelated collisions.
- Kept the quick-action picker compact by hiding agent-facing tips from its rows while preserving them in feedback.
- Simplified `/nvim-last` output to `nvim -c 'NvimotatorAttach <id>'`; Neovim installation is documented through lazy.nvim/LazyVim.
