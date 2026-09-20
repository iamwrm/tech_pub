---
name: nvim-import
description: Print the path of the last Neovim annotation file so it can be Read. Does not dump the annotation body.
disable-model-invocation: true
allowed-tools: Bash(nvimotator:*) Bash(${CLAUDE_PLUGIN_ROOT}/bin/nvimotator:*)
---

# Nvimotator Import

Do not send a commentary/status message first.

The following shell prints one absolute annotation path and exits. Read that
file with the Read tool. Do not assume the annotation body was printed on
stdout.

!`"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" last`

If the user named a numeric id, run
`"${CLAUDE_PLUGIN_ROOT}/bin/nvimotator" import $ARGUMENTS` instead and Read the
printed path. `import <id>` also frees that 1–99 slot for reuse. `last` is the
stable last-sent copy and is not a rotating slot.
