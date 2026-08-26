local M = {}

local Store = {}
Store.__index = Store

local function copy(value)
  return vim.deepcopy(value)
end

local MAX_ANNOTATIONS = 200
local MAX_COMMENT_BYTES = 16 * 1024

local function validate_comment(comment)
  if type(comment) ~= "string" or not comment:match("%S") then
    return nil, "Nvimotator comments cannot be empty."
  end
  if #comment > MAX_COMMENT_BYTES then
    return nil, string.format("Nvimotator comments cannot exceed %d UTF-8 bytes.", MAX_COMMENT_BYTES)
  end
  return true
end

local function summary(annotation)
  if annotation.kind == "quickAction" then
    return annotation.actionLabel or annotation.actionId
  end
  local first = annotation.comment:match("[^\r\n]*") or "Comment"
  if vim.fn.strchars(first) > 48 then
    first = vim.fn.strcharpart(first, 0, 45) .. "..."
  end
  return first
end

function Store.new(bufnr, on_change)
  return setmetatable({
    bufnr = bufnr,
    records = {},
    next_id = 1,
    namespace = vim.api.nvim_create_namespace("pi-nvimotator-annotations"),
    on_change = on_change,
  }, Store)
end

function Store:_changed()
  self:render()
  if self.on_change then
    self.on_change()
  end
end

function Store:_id()
  local id = string.format("annotation-%d", self.next_id)
  self.next_id = self.next_id + 1
  return id
end

function Store:add_comment(anchor, comment)
  if #self.records >= MAX_ANNOTATIONS then return nil, "Nvimotator supports at most 200 annotations." end
  local valid, validation_error = validate_comment(comment)
  if not valid then return nil, validation_error end
  local record = {
    id = self:_id(),
    kind = "comment",
    comment = comment,
  }
  if anchor then
    record.anchor = copy(anchor)
  end
  table.insert(self.records, record)
  self:_changed()
  return record.id
end

function Store:add_action(anchor, action)
  if #self.records >= MAX_ANNOTATIONS then return nil, "Nvimotator supports at most 200 annotations." end
  if type(anchor) ~= "table" or type(action) ~= "table" or type(action.id) ~= "string" then
    return nil, "Nvimotator quick action is invalid."
  end
  local record = {
    id = self:_id(),
    kind = "quickAction",
    anchor = copy(anchor),
    actionId = action.id,
    actionLabel = action.label,
  }
  table.insert(self.records, record)
  self:_changed()
  return record.id
end

function Store:replace(records)
  self.records = {}
  local largest = 0
  for _, record in ipairs(records or {}) do
    table.insert(self.records, copy(record))
    local number = tonumber(tostring(record.id):match("^annotation%-(%d+)$"))
    if number and number > largest then
      largest = number
    end
  end
  self.next_id = largest + 1
  self:render()
end

function Store:list()
  return copy(self.records)
end

function Store:count()
  return #self.records
end

function Store:get(id)
  for _, record in ipairs(self.records) do
    if record.id == id then
      return record
    end
  end
end

function Store:edit(id, comment)
  local record = self:get(id)
  if not record or record.kind ~= "comment" then
    return nil, "Nvimotator comment was not found."
  end
  local valid, validation_error = validate_comment(comment)
  if not valid then return nil, validation_error end
  record.comment = comment
  self:_changed()
  return true
end

function Store:delete(id)
  for index, record in ipairs(self.records) do
    if record.id == id then
      table.remove(self.records, index)
      self:_changed()
      return true
    end
  end
  return false
end

function Store:remove_unchanged(submitted)
  local accepted = {}
  for _, record in ipairs(submitted) do
    accepted[record.id] = record
  end
  local kept = {}
  for _, record in ipairs(self.records) do
    if not accepted[record.id] or not vim.deep_equal(accepted[record.id], record) then
      table.insert(kept, record)
    end
  end
  self.records = kept
  self:_changed()
end

function Store:clear()
  self.records = {}
  self:_changed()
end

local function global_panel_lines(records)
  local globals = {}
  for _, record in ipairs(records) do
    if record.kind == "comment" and not record.anchor then table.insert(globals, record) end
  end
  if #globals == 0 then return nil end

  local lines = {
    {
      { "╭─ ", "NvimotatorGlobalBorder" },
      { string.format("Global feedback (%d)", #globals), "NvimotatorGlobalTitle" },
    },
  }
  for _, record in ipairs(globals) do
    table.insert(lines, {
      { "│ ", "NvimotatorGlobalBorder" },
      { "◆ ", "NvimotatorGlobalTitle" },
      { record.id .. "  ", "NvimotatorGlobalHint" },
      { summary(record), "NvimotatorGlobalComment" },
    })
  end
  table.insert(lines, {
    { "╰─ ", "NvimotatorGlobalBorder" },
    { "\\ng add · \\nc manage", "NvimotatorGlobalHint" },
  })
  return lines
end

function Store:render()
  if not self.bufnr or not vim.api.nvim_buf_is_valid(self.bufnr) then
    return
  end
  vim.api.nvim_buf_clear_namespace(self.bufnr, self.namespace, 0, -1)
  local panel = global_panel_lines(self.records)
  if panel then
    pcall(vim.api.nvim_buf_set_extmark, self.bufnr, self.namespace, 0, 0, {
      id = MAX_ANNOTATIONS + 1,
      virt_lines = panel,
      virt_lines_above = true,
      right_gravity = false,
    })
  end
  for index, record in ipairs(self.records) do
    if record.anchor then
      local anchor = record.anchor
      local start_row = anchor.startLine - 1
      local end_row = anchor.endLine - 1
      local end_col = anchor.endByte
      local opts = {
        id = index,
        end_row = end_row,
        end_col = end_col,
        hl_group = record.kind == "quickAction" and "DiagnosticInfo" or "Visual",
        sign_text = "●",
        sign_hl_group = record.kind == "quickAction" and "DiagnosticInfo" or "DiagnosticHint",
        virt_text = { { string.format("[%s] %s", record.id, summary(record)), "Comment" } },
        virt_text_pos = "eol",
        right_gravity = false,
        end_right_gravity = true,
      }
      pcall(vim.api.nvim_buf_set_extmark, self.bufnr, self.namespace, start_row, anchor.startByte, opts)
    end
  end
end

function Store:jump(id)
  local record = self:get(id)
  if not record or not record.anchor then
    return false
  end
  if self.bufnr and vim.api.nvim_buf_is_valid(self.bufnr) then
    vim.api.nvim_set_current_buf(self.bufnr)
    vim.api.nvim_win_set_cursor(0, { record.anchor.startLine, record.anchor.startByte })
    return true
  end
  return false
end

function Store:set_buffer(bufnr)
  self.bufnr = bufnr
  self:render()
end

M.Store = Store
return M
