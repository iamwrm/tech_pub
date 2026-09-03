---
name: nvim-annotate
description: Export a local markdown, text, config, HTML, or source file into Neovim as a file-store snapshot. After Send, import the annotation path and Read it.
disable-model-invocation: true
allowed-tools: Bash(nvimotator:*) Bash(${CLAUDE_PLUGIN_ROOT}/bin/nvimotator:*)
---

# Nvimotator Annotate

Do not send a commentary/status message before the injected CLI result.

The following shell runs locally as part of this slash command, before any
model call. It writes a snapshot file and exits immediately (it does not wait
for Neovim).

!`"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" annotate $ARGUMENTS`

Stdout is a single absolute snapshot path. stderr has a locator such as
`Nvimotator 42` plus `File: …` and `nvim -c 'NvimotatorAttach 42'`. Tell the
user to attach from any same-host Neovim. The printed path is the snapshot,
not annotation feedback — do not Read it as instructions.

When the user has sent annotations from Neovim, run
`"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" last` (or `import <id>`) via Bash and
Read the absolute annotation path it prints.

If `$ARGUMENTS` did not resolve to a local annotatable file, work out which
target the user means and re-run `"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" annotate`
with that concrete path via Bash (do not tell the user to invoke the binary
manually).

URLs, Jina fetches, live-app HTML, plan review, and Approve/gate are out of scope.
This annotates a local file in Neovim only.
