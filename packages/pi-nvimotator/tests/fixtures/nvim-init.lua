vim.opt.runtimepath:prepend(assert(vim.env.PI_NVIMOTATOR_PACKAGE))
vim.opt.swapfile = false
vim.opt.shadafile = "NONE"
vim.g.pi_nvimotator_disable_default_mappings = false

local artifact_dir = assert(vim.env.NVIMOTATOR_E2E_ARTIFACTS)
local export_path = assert(vim.env.NVIMOTATOR_E2E_EXPORT)

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



require("pi_nvimotator").setup({
  clipboard = function(text)
    write_bytes(export_path, text)
    return true
  end,
})
vim.cmd("runtime plugin/pi_nvimotator.lua")

_G.nvimotator_e2e = {}

function _G.nvimotator_e2e.attach_via_mapping(id)
  local keys = vim.api.nvim_replace_termcodes("<leader>nt", true, false, true)
  vim.api.nvim_feedkeys(keys, "mx", false)
  local active = assert(require("pi_nvimotator.modal")._active(), "attach input did not open")
  vim.api.nvim_buf_set_lines(active.buffer, 0, -1, false, { tostring(id) })
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
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

local function assert_displaced_modal()
  local active = assert(require("pi_nvimotator.modal")._active(), "owned modal did not open")
  if active.lease.kind ~= "float" then return end
  local config = vim.api.nvim_win_get_config(active.lease.window)
  local outer_top = config.row + 1
  local outer_bottom = outer_top + config.height + 1
  local overlap = 0
  for line = 1, vim.api.nvim_buf_line_count(active.lease.source_buffer) do
    local position = vim.fn.screenpos(active.lease.source_window, line, 1)
    if position.row >= outer_top and position.row <= outer_bottom then overlap = overlap + 1 end
  end
  assert(overlap == 0, "owned modal overlaps real source rows")
  write_bytes(artifact_dir .. "/modal-geometry.json", vim.json.encode({
    kind = active.lease.kind,
    overlap = overlap,
    occupiedRows = active.lease.occupied_rows,
    floatHeight = config.height,
  }))
end

local function submit_comment(text, open_editor)
  local before = _G.nvimotator_e2e.count()
  open_editor()
  assert(require("pi_nvimotator.modal").is_open(), "comment editor did not open")
  assert_displaced_modal()
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
  local before = _G.nvimotator_e2e.count()
  vim.cmd("7NvimotatorQuick")
  assert_displaced_modal()
  local active = assert(require("pi_nvimotator.modal")._active())
  vim.api.nvim_win_set_cursor(active.lease.window, { 4, 0 })
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
  assert(vim.wait(1000, function() return _G.nvimotator_e2e.count() == before + 1 end), "quick action was not saved")
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
