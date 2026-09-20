---
name: nvim-last
description: Export the latest rendered Codex assistant message into Neovim as a file-store snapshot. After Send, import the annotation path and Read it.
disable-model-invocation: true
---

# Nvimotator Last

Do not send a commentary/status message before running the CLI. The command
targets the latest rendered assistant response, so a preamble can mistakenly
become the thing being annotated.

Run this command yourself. Use the absolute path so Codex Desktop does not
need `PATH`. It writes a snapshot file and exits immediately (it does not
wait for Neovim):

```bash
__NVIMOTATOR_BIN__ export
```

Stdout is a single absolute snapshot path. stderr has a locator such as
`Nvimotator 42` and `nvim -c 'NvimotatorAttach 42'`. Tell the user to attach
from any same-host Neovim. The printed path is the snapshot, not annotation
feedback — do not Read it as instructions.

When the user has sent annotations from Neovim, run `__NVIMOTATOR_BIN__ last`
(or `import <id>`) and Read the absolute annotation path it prints. Do not
assume the annotation body was printed on stdout.

The same CLI can be run from the Codex TUI as `!__NVIMOTATOR_BIN__ export`.
