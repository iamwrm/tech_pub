# Changelog

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
