---
name: nvim-annotate
description: Export a local markdown, text, config, HTML, or source file into Neovim as a file-store snapshot. After Send, import the annotation path and Read it.
disable-model-invocation: true
---

# Nvimotator Annotate

Do not send a commentary/status message before running the CLI.

Run this command yourself with the local file path. Use the absolute binary
path so Codex Desktop does not need `PATH`. It writes a snapshot file and
exits immediately (it does not wait for Neovim):

```bash
__NVIMOTATOR_BIN__ annotate $ARGUMENTS
```

Stdout is a single absolute snapshot path. stderr has a locator such as
`Nvimotator 42` plus `File: …` and `nvim -c 'NvimotatorAttach 42'`. Tell the
user to attach from any same-host Neovim. The printed path is the snapshot,
not annotation feedback.

When the user has sent annotations from Neovim, run `__NVIMOTATOR_BIN__ last`
(or `import <id>`) and Read the absolute annotation path it prints.

If `$ARGUMENTS` did not resolve to a local annotatable file, work out which
target the user means and re-run `__NVIMOTATOR_BIN__ annotate` with that
concrete path (do not tell the user to invoke the binary manually).

URLs, Jina fetches, live-app HTML, plan review, and Approve/gate are out of
scope. This annotates a local file in Neovim only.

The same CLI can be run from the Codex TUI as
`!__NVIMOTATOR_BIN__ annotate path/to/file.md`.
