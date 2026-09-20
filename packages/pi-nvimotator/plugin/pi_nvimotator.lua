if vim.g.loaded_pi_nvimotator == 1 then return end

local command_names = {
  "NvimotatorAttach", "NvimotatorAnnotate", "NvimotatorQuick", "NvimotatorComment",
  "NvimotatorComments", "NvimotatorExport", "NvimotatorSend", "NvimotatorClear",
  "NvimotatorCancel",
}
local plug_keys = {
  { mode = "n", lhs = "<Plug>(NvimotatorAttach)" },
  { mode = "n", lhs = "<Plug>(NvimotatorAnnotate)" },
  { mode = "x", lhs = "<Plug>(NvimotatorAnnotate)" },
  { mode = "n", lhs = "<Plug>(NvimotatorQuick)" },
  { mode = "x", lhs = "<Plug>(NvimotatorQuick)" },
  { mode = "n", lhs = "<Plug>(NvimotatorComment)" },
  { mode = "n", lhs = "<Plug>(NvimotatorComments)" },
  { mode = "n", lhs = "<Plug>(NvimotatorSend)" },
  { mode = "n", lhs = "<Plug>(NvimotatorCancel)" },
}

local existing_commands = vim.api.nvim_get_commands({ builtin = false })
local legacy_owned = true
for _, name in ipairs(command_names) do
  if not existing_commands[name] then legacy_owned = false; break end
end
if legacy_owned then
  for _, mapping in ipairs(plug_keys) do
    if vim.fn.maparg(mapping.lhs, mapping.mode) == "" then legacy_owned = false; break end
  end
end
local owns_registrations = vim.g.pi_nvimotator_owns_registrations == 1 or legacy_owned

if not owns_registrations then
  for _, name in ipairs(command_names) do
    if existing_commands[name] then
      vim.notify("pi-nvimotator refused to replace existing command :" .. name, vim.log.levels.WARN)
      return
    end
  end
  for _, mapping in ipairs(plug_keys) do
    if vim.fn.maparg(mapping.lhs, mapping.mode) ~= "" then
      vim.notify("pi-nvimotator refused to replace existing mapping " .. mapping.lhs, vim.log.levels.WARN)
      return
    end
  end
else
  for _, name in ipairs(command_names) do pcall(vim.api.nvim_del_user_command, name) end
  for _, mapping in ipairs(plug_keys) do pcall(vim.keymap.del, mapping.mode, mapping.lhs) end
end

local nvimotator = require("pi_nvimotator")

for name, link in pairs({
  NvimotatorGlobalBorder = "FloatBorder",
  NvimotatorGlobalTitle = "Title",
  NvimotatorGlobalComment = "Comment",
  NvimotatorGlobalHint = "DiagnosticHint",
}) do
  vim.api.nvim_set_hl(0, name, { link = link, default = true })
end

local function command(name, callback, options)
  vim.api.nvim_create_user_command(name, callback, options or {})
end

local function range(opts)
  if opts.range == 0 then
    local line = vim.api.nvim_win_get_cursor(0)[1]
    return line, line
  end
  return opts.line1, opts.line2
end

command("NvimotatorAttach", function(opts) nvimotator.attach(opts.args) end, { nargs = 1, complete = "file" })
command("NvimotatorAnnotate", function(opts)
  local first, last = range(opts)
  nvimotator.annotate_range(first, last)
end, { range = true })
command("NvimotatorQuick", function(opts)
  local first, last = range(opts)
  nvimotator.quick_range(first, last)
end, { range = true })
command("NvimotatorComment", function() nvimotator.comment() end)
command("NvimotatorComments", function() nvimotator.comments() end)
command("NvimotatorExport", function() nvimotator.export() end)
command("NvimotatorSend", function() nvimotator.send() end)
command("NvimotatorClear", function() nvimotator.clear() end)
command("NvimotatorCancel", function() nvimotator.cancel() end)

local plugs = {
  { mode = "n", lhs = "<Plug>(NvimotatorAttach)", rhs = function() nvimotator.attach_prompt() end },
  { mode = "n", lhs = "<Plug>(NvimotatorAnnotate)", rhs = function()
    local line = vim.api.nvim_win_get_cursor(0)[1]
    nvimotator.annotate_range(line, line)
  end },
  { mode = "x", lhs = "<Plug>(NvimotatorAnnotate)", rhs = function() nvimotator.annotate_visual() end },
  { mode = "n", lhs = "<Plug>(NvimotatorQuick)", rhs = function()
    local line = vim.api.nvim_win_get_cursor(0)[1]
    nvimotator.quick_range(line, line)
  end },
  { mode = "x", lhs = "<Plug>(NvimotatorQuick)", rhs = function() nvimotator.quick_visual() end },
  { mode = "n", lhs = "<Plug>(NvimotatorComment)", rhs = function() nvimotator.comment() end },
  { mode = "n", lhs = "<Plug>(NvimotatorComments)", rhs = function() nvimotator.comments() end },
  { mode = "n", lhs = "<Plug>(NvimotatorSend)", rhs = function() nvimotator.send() end },
  { mode = "n", lhs = "<Plug>(NvimotatorCancel)", rhs = function() nvimotator.cancel() end },
}

for _, mapping in ipairs(plugs) do
  vim.keymap.set(mapping.mode, mapping.lhs, mapping.rhs, {
    silent = true,
    desc = "pi-nvimotator " .. mapping.lhs,
  })
end

if vim.g.pi_nvimotator_disable_default_mappings ~= true then
  local defaults = {
    { mode = "n", lhs = "<leader>nt", rhs = "<Plug>(NvimotatorAttach)" },
    { mode = "n", lhs = "<leader>na", rhs = "<Plug>(NvimotatorAnnotate)" },
    { mode = "x", lhs = "<leader>na", rhs = "<Plug>(NvimotatorAnnotate)" },
    { mode = "n", lhs = "<leader>nq", rhs = "<Plug>(NvimotatorQuick)" },
    { mode = "x", lhs = "<leader>nq", rhs = "<Plug>(NvimotatorQuick)" },
    { mode = "n", lhs = "<leader>ng", rhs = "<Plug>(NvimotatorComment)" },
    { mode = "n", lhs = "<leader>nc", rhs = "<Plug>(NvimotatorComments)" },
    { mode = "n", lhs = "<leader>ns", rhs = "<Plug>(NvimotatorSend)" },
  }
  for _, mapping in ipairs(defaults) do
    if vim.fn.maparg(mapping.lhs, mapping.mode) == "" then
      vim.keymap.set(mapping.mode, mapping.lhs, mapping.rhs, { remap = true, silent = true })
    end
  end
end

vim.g.pi_nvimotator_owns_registrations = 1
vim.g.loaded_pi_nvimotator = 1
