---
name: nvim-import
description: Print the path of the last Neovim annotation file so it can be Read. Does not dump the annotation body.
disable-model-invocation: true
---

# Nvimotator Import

Do not send a commentary/status message first.

Run this command yourself. It prints one absolute annotation path and exits.
Read that file. Do not assume the annotation body was printed on stdout.

```bash
__NVIMOTATOR_BIN__ last
```

If the user named a numeric id, run `__NVIMOTATOR_BIN__ import <id>` instead
and Read the printed path. `import <id>` also frees that 1–99 slot for reuse.
`last` is the stable last-sent copy and is not a rotating slot.

The same CLI can be run from the Codex TUI as `!__NVIMOTATOR_BIN__ last`.
