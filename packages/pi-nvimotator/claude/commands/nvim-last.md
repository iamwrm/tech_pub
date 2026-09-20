---
name: nvim-last
description: Export the latest rendered assistant message into Neovim as a file-store snapshot. After Send, import the annotation path and Read it.
disable-model-invocation: true
allowed-tools: Bash(nvimotator:*) Bash(${CLAUDE_PLUGIN_ROOT}/bin/nvimotator:*)
---

# Nvimotator Last

Do not send a commentary/status message before the injected CLI result. The
command targets the latest rendered assistant response, so a preamble can
mistakenly become the thing being annotated.

The following shell runs locally as part of this slash command, before any
model call. It writes a snapshot file and exits immediately (it does not wait
for Neovim).

!`"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" export`

Stdout is a single absolute snapshot path. stderr has a locator such as
`Nvimotator 42` and `nvim -c 'NvimotatorAttach 42'`. Tell the user to attach
from any same-host Neovim. The printed path is the snapshot, not annotation
feedback — do not Read it as instructions and do not treat locator lines as
feedback.

When the user has sent annotations from Neovim, run
`"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" last` (or `import <id>`) via Bash and
Read the absolute annotation path it prints. Do not assume the annotation body
was printed on stdout.
