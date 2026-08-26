vim.opt.runtimepath:prepend(assert(vim.env.PI_NVIMOTATOR_PACKAGE))
vim.opt.swapfile = false
vim.opt.shadafile = "NONE"
vim.g.pi_nvimotator_disable_default_mappings = true

local artifact_dir = assert(vim.env.NVIMOTATOR_E2E_ARTIFACTS)
local export_path = assert(vim.env.NVIMOTATOR_E2E_EXPORT)
local select_queue = {}

local function write_bytes(path, bytes)
  local file = assert(io.open(path, "wb"))
  file:write(bytes)
  file:close()
end

vim.notify = function(message, level)
  local file = io.open(artifact_dir .. "/nvim-notifications.log", "ab")
  if file then
    file:write(string.format("%s\t%s\n", tostring(level or ""), tostring(message):gsub("[\r\n]", " ")))
    file:close()
  end
end


vim.ui.select = function(items, _, callback)
  local choice = table.remove(select_queue, 1) or 1
  callback(items[choice])
end

require("pi_nvimotator").setup({
  clipboard = function(text)
    write_bytes(export_path, text)
    return true
  end,
})
vim.cmd("runtime plugin/pi_nvimotator.lua")

_G.nvimotator_e2e = {}

function _G.nvimotator_e2e.attach(id)
  vim.cmd("NvimotatorAttach " .. tostring(id))
  return true
end

function _G.nvimotator_e2e.phase()
  return require("pi_nvimotator")._state().phase
end

function _G.nvimotator_e2e.count()
  local store = require("pi_nvimotator")._state().store
  return store and store:count() or -1
end

function _G.nvimotator_e2e.capture()
  local state = require("pi_nvimotator")._state()
  local lines = vim.api.nvim_buf_get_lines(state.bufnr, 0, -1, true)
  write_bytes(artifact_dir .. "/attached.bin", table.concat(lines, "\n"))
  write_bytes(artifact_dir .. "/attached.json", vim.json.encode({
    cwd = vim.fn.getcwd(),
    bridgeId = state.manifest.bridgeId,
    snapshotId = state.snapshot.snapshotId,
    buftype = vim.bo[state.bufnr].buftype,
    filetype = vim.bo[state.bufnr].filetype,
    modifiable = vim.bo[state.bufnr].modifiable,
    readonly = vim.bo[state.bufnr].readonly,
    swapfile = vim.bo[state.bufnr].swapfile,
  }))
  return true
end

local function submit_comment(text, open_editor)
  local before = _G.nvimotator_e2e.count()
  open_editor()
  assert(require("pi_nvimotator.modal").is_open(), "comment editor did not open")
  local buffer = vim.api.nvim_get_current_buf()
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.split(text, "\n", { plain = true }))
  local submit = vim.api.nvim_replace_termcodes("<C-s>", true, false, true)
  vim.api.nvim_feedkeys(submit, "mx", false)
  assert(vim.wait(1000, function() return _G.nvimotator_e2e.count() == before + 1 end), "comment was not saved")
  return _G.nvimotator_e2e.count()
end

function _G.nvimotator_e2e.annotate_line()
  return submit_comment("Tighten this line.", function() vim.cmd("3NvimotatorAnnotate") end)
end

function _G.nvimotator_e2e.annotate_visual()
  return submit_comment("Explain the emoji context.", function()
    vim.api.nvim_win_set_cursor(0, { 4, 6 })
    vim.cmd("normal! v")
    local plug = vim.api.nvim_replace_termcodes("<Plug>(NvimotatorAnnotate)", true, false, true)
    vim.api.nvim_feedkeys(plug, "mx", false)
  end)
end

function _G.nvimotator_e2e.global_comment()
  return submit_comment("Overall feedback.\nSecond global line.", function()
    local plug = vim.api.nvim_replace_termcodes("<Plug>(NvimotatorComment)", true, false, true)
    vim.api.nvim_feedkeys(plug, "mx", false)
  end)
end

function _G.nvimotator_e2e.capture_global_panel()
  local state = require("pi_nvimotator")._state()
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(state.bufnr, state.store.namespace, 0, -1, { details = true })) do
    local virtual_lines = mark[4] and mark[4].virt_lines
    if virtual_lines then
      local lines = {}
      for _, virtual_line in ipairs(virtual_lines) do
        local chunks = {}
        for _, chunk in ipairs(virtual_line) do table.insert(chunks, chunk[1]) end
        table.insert(lines, table.concat(chunks))
      end
      write_bytes(artifact_dir .. "/global-panel.txt", table.concat(lines, "\n"))
      return true
    end
  end
  return false
end

function _G.nvimotator_e2e.quick_line()
  table.insert(select_queue, 4)
  vim.cmd("7NvimotatorQuick")
  return _G.nvimotator_e2e.count()
end

function _G.nvimotator_e2e.export()
  vim.cmd("NvimotatorExport")
  return true
end

function _G.nvimotator_e2e.send()
  vim.cmd("NvimotatorSend")
  return true
end
