local layout = require("pi_nvimotator.layout")
local M = {}

-- Floating comment editor adapted from jillesme/pi-nvim-review (MIT).
-- See THIRD_PARTY_NOTICES.md.
local active
local buffer_counter = 0

local function valid_buffer(buffer)
  return buffer and vim.api.nvim_buf_is_valid(buffer)
end

local function valid_window(window)
  return window and vim.api.nvim_win_is_valid(window)
end

local function title_text(title, width)
  return " " .. vim.fn.strcharpart(title, 0, math.max(1, width - 4)) .. " "
end

local function create_buffer(kind, filetype)
  buffer_counter = buffer_counter + 1
  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, string.format("nvimotator://%s/%d", kind, buffer_counter))
  vim.bo[buffer].buftype = "nofile"
  vim.bo[buffer].bufhidden = "wipe"
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].filetype = filetype or "nvimotator"
  return buffer
end

local function finish(value)
  local current = active
  if not current then return end
  active = nil
  if valid_window(current.lease.window) and vim.api.nvim_get_current_win() == current.lease.window then
    pcall(vim.cmd.stopinsert)
  end
  layout.close(current.lease)
  if valid_buffer(current.buffer) then pcall(vim.api.nvim_buf_delete, current.buffer, { force = true }) end
  vim.schedule(function() current.callback(value) end)
end

local function open_modal(buffer, options, callback)
  if active then return nil, "another Nvimotator modal is already open" end
  local lease, open_error = layout.open(buffer, options)
  if not lease then return nil, open_error end
  active = { buffer = buffer, lease = lease, callback = callback }
  vim.api.nvim_create_autocmd("WinClosed", {
    pattern = tostring(lease.window),
    once = true,
    callback = function()
      if active and active.lease.window == lease.window then finish(nil) end
    end,
  })
  return lease.window, lease
end

local function common_window_options(window, wrap)
  vim.wo[window].wrap = wrap == true
  vim.wo[window].linebreak = wrap == true
  vim.wo[window].number = false
  vim.wo[window].relativenumber = false
  vim.wo[window].signcolumn = "no"
  vim.wo[window].foldcolumn = "0"
end

local function cancel_mappings(buffer)
  local options = { buffer = buffer, silent = true, nowait = true }
  -- Text editors are real scratch buffers: do not map <Esc>/<C-[>. Insert Esc
  -- leaves insert; normal Esc is a no-op. Mapping Esc with nowait swallows
  -- terminal bracketed paste (CSI 200~) on Windows Terminal / Herdr.
  vim.keymap.set({ "n", "i" }, "<C-c>", function() finish(nil) end, options)
end

local function picker_cancel_mappings(buffer)
  cancel_mappings(buffer)
  vim.keymap.set("n", "q", function() finish(nil) end, { buffer = buffer, silent = true, nowait = true })
end

function M.comment(options, callback)
  options = options or {}
  local width = options.width or 72
  local buffer = create_buffer("comment", "markdown")
  if type(options.initial_text) == "string" and options.initial_text ~= "" then
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, vim.split(options.initial_text, "\n", { plain = true }))
  end
  local window, lease_or_error = open_modal(buffer, {
    source_window = options.source_window,
    target_line = options.target_line,
    width = width,
    height = options.height or 8,
    title = title_text(options.title or "Nvimotator comment", width),
    footer = " <C-s> save · <C-c> cancel ",
  }, callback)
  if not window then
    pcall(vim.api.nvim_buf_delete, buffer, { force = true })
    return nil, lease_or_error
  end
  common_window_options(window, true)

  local function submit()
    if not valid_buffer(buffer) then finish(nil); return end
    finish(table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), "\n"))
  end
  local map_options = { buffer = buffer, silent = true, nowait = true }
  vim.keymap.set({ "n", "i" }, "<C-s>", submit, map_options)
  cancel_mappings(buffer)
  vim.schedule(function()
    if valid_window(window) then
      vim.api.nvim_set_current_win(window)
      local last_line = vim.api.nvim_buf_line_count(buffer)
      local last_text = vim.api.nvim_buf_get_lines(buffer, last_line - 1, last_line, false)[1] or ""
      vim.api.nvim_win_set_cursor(window, { last_line, #last_text })
      vim.cmd.startinsert()
    end
  end)
  return window
end

function M.input(options, callback)
  options = options or {}
  local width = options.width or 44
  local buffer = create_buffer("input", "nvimotator")
  if type(options.default) == "string" then
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { options.default })
  end
  local window, lease_or_error = open_modal(buffer, {
    source_window = options.source_window,
    target_line = options.target_line,
    width = width,
    height = 1,
    title = title_text(options.prompt or "Nvimotator input", width),
    footer = " <Enter> accept · <C-c> cancel ",
  }, callback)
  if not window then
    pcall(vim.api.nvim_buf_delete, buffer, { force = true })
    return nil, lease_or_error
  end
  common_window_options(window, false)
  local function submit()
    local value = valid_buffer(buffer) and (vim.api.nvim_buf_get_lines(buffer, 0, 1, false)[1] or "") or nil
    finish(value)
  end
  local map_options = { buffer = buffer, silent = true, nowait = true }
  vim.keymap.set({ "n", "i" }, "<CR>", submit, map_options)
  cancel_mappings(buffer)
  vim.schedule(function()
    if valid_window(window) then
      vim.api.nvim_set_current_win(window)
      local value = vim.api.nvim_buf_get_lines(buffer, 0, 1, false)[1] or ""
      vim.api.nvim_win_set_cursor(window, { 1, #value })
      vim.cmd.startinsert()
    end
  end)
  return window
end

local function picker_search_text(label)
  local text = tostring(label)
  -- Prefix-match the visible name after leading emoji/punctuation (so `L`
  -- matches "👍 Looks good" without being fuzzy).
  local stripped = text:gsub("^[^%a]*", "")
  return vim.fn.tolower(text), vim.fn.tolower(stripped)
end

local function picker_prefix_match(label, query)
  if query == "" then return true end
  local needle = vim.fn.tolower(query)
  local full, stripped = picker_search_text(label)
  return vim.startswith(full, needle) or vim.startswith(stripped, needle)
end

function M.select(items, options, callback)
  options = options or {}
  if #items == 0 then return nil, "Nvimotator picker has no items" end
  local labels = {}
  local width = vim.fn.strdisplaywidth(options.prompt or "Nvimotator") + 4
  for _, item in ipairs(items) do
    local value = options.format_item and options.format_item(item) or tostring(item)
    value = tostring(value):gsub("[\r\n]", " ↵ ")
    table.insert(labels, value)
    width = math.max(width, vim.fn.strdisplaywidth(value) + 2)
  end
  local footer_idle = " type to filter · j/k move · <Enter> select · q/<C-c> cancel "
  width = math.max(width, vim.fn.strdisplaywidth(footer_idle) + 2)
  width = math.min(options.width or 80, width)
  local buffer = create_buffer("select", "nvimotator")
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, labels)
  vim.bo[buffer].modifiable = false
  local window, lease_or_error = open_modal(buffer, {
    source_window = options.source_window,
    target_line = options.target_line,
    width = width,
    height = math.min(#items, options.height or 10),
    title = title_text(options.prompt or "Nvimotator", width),
    footer = footer_idle,
  }, callback)
  if not window then
    pcall(vim.api.nvim_buf_delete, buffer, { force = true })
    return nil, lease_or_error
  end
  common_window_options(window, false)
  vim.wo[window].cursorline = true

  local query = ""
  local filtered = {}
  for index, item in ipairs(items) do
    filtered[index] = { item = item, label = labels[index] }
  end

  local function footer_text()
    if query == "" then return footer_idle end
    return string.format(" filter: %s · <BS>/<C-u> · <Enter> · q/<C-c> ", query)
  end

  local function refresh_footer()
    if not valid_window(window) then return end
    local config = vim.api.nvim_win_get_config(window)
    if config.relative == nil or config.relative == "" then return end
    pcall(vim.api.nvim_win_set_config, window, {
      footer = footer_text(),
      footer_pos = "center",
    })
  end

  local function selected_item()
    if not valid_window(window) or #filtered == 0 then return nil end
    local row = vim.api.nvim_win_get_cursor(window)[1]
    local entry = filtered[row]
    return entry and entry.item or nil
  end

  local function render()
    if not valid_buffer(buffer) then return end
    local keep = selected_item()
    filtered = {}
    local lines = {}
    for index, item in ipairs(items) do
      local label = labels[index]
      if picker_prefix_match(label, query) then
        table.insert(filtered, { item = item, label = label })
        table.insert(lines, label)
      end
    end
    vim.bo[buffer].modifiable = true
    if #lines == 0 then
      vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "(no matches)" })
    else
      vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    end
    vim.bo[buffer].modifiable = false
    if valid_window(window) and #filtered > 0 then
      local row = 1
      if keep then
        for index, entry in ipairs(filtered) do
          if entry.item == keep then row = index; break end
        end
      end
      pcall(vim.api.nvim_win_set_cursor, window, { row, 0 })
    end
    refresh_footer()
    if active and active.buffer == buffer then
      active.filter_query = query
      active.filtered = filtered
    end
  end

  local function choose()
    if #filtered == 0 then return end
    if not valid_window(window) then finish(nil); return end
    local row = vim.api.nvim_win_get_cursor(window)[1]
    local entry = filtered[row]
    if not entry then return end
    finish(entry.item)
  end

  local function move(delta)
    if not valid_window(window) or #filtered == 0 then return end
    local row = vim.api.nvim_win_get_cursor(window)[1]
    vim.api.nvim_win_set_cursor(window, { math.max(1, math.min(#filtered, row + delta)), 0 })
  end

  local map_options = { buffer = buffer, silent = true, nowait = true }
  -- Pickers are not text editors. Map <CR> in visual/insert too so a leftover
  -- visual mapping or unscheduled insert state still selects instead of no-op.
  vim.keymap.set({ "n", "i", "x" }, "<CR>", choose, map_options)
  vim.keymap.set("n", "j", function() move(1) end, map_options)
  vim.keymap.set("n", "k", function() move(-1) end, map_options)
  vim.keymap.set("n", "<Down>", function() move(1) end, map_options)
  vim.keymap.set("n", "<Up>", function() move(-1) end, map_options)
  vim.keymap.set("n", "<C-n>", function() move(1) end, map_options)
  vim.keymap.set("n", "<C-p>", function() move(-1) end, map_options)
  vim.keymap.set("n", "<BS>", function()
    query = query:sub(1, math.max(0, #query - 1))
    render()
  end, map_options)
  vim.keymap.set("n", "<C-h>", function()
    query = query:sub(1, math.max(0, #query - 1))
    render()
  end, map_options)
  vim.keymap.set("n", "<C-u>", function()
    query = ""
    render()
  end, map_options)
  -- Lua 5.1/LuaJIT reuses loop locals; bind through a function so each key
  -- keeps its own character. j/k move and q cancels; other letters filter.
  local function bind_filter_key(key, chunk)
    vim.keymap.set("n", key, function()
      query = query .. chunk
      render()
    end, map_options)
  end
  for byte = string.byte("a"), string.byte("z") do
    local letter = string.char(byte)
    if letter ~= "j" and letter ~= "k" and letter ~= "q" then
      bind_filter_key(letter, letter)
      bind_filter_key(letter:upper(), letter)
    end
  end
  for digit = 0, 9 do
    local key = tostring(digit)
    bind_filter_key(key, key)
  end
  picker_cancel_mappings(buffer)
  if active and active.buffer == buffer then
    active.filter_query = query
    active.filtered = filtered
  end
  vim.schedule(function()
    if valid_window(window) then
      vim.api.nvim_set_current_win(window)
      pcall(vim.cmd.stopinsert)
    end
  end)
  return window
end

function M.quick(actions, callback, options)
  options = options or {}
  return M.select(actions, {
    prompt = "Nvimotator quick action",
    format_item = function(action) return action.label end,
    source_window = options.source_window,
    target_line = options.target_line,
    height = options.height or #actions,
  }, function(action)
    -- Owned picker cancel/WinClosed calls finish(nil). The pre-in-place
    -- vim.ui.select wrapper ignored nil; without this, add_action(nil) warns
    -- "Nvimotator quick action is invalid."
    if action then callback(action) end
  end)
end

local function label(record)
  local location = "general"
  if record.anchor then
    location = record.anchor.startLine == record.anchor.endLine
      and string.format("line %d", record.anchor.startLine)
      or string.format("lines %d-%d", record.anchor.startLine, record.anchor.endLine)
  end
  local content = record.kind == "comment" and record.comment or (record.actionLabel or record.actionId)
  content = content:gsub("\n", " ↵ ")
  if vim.fn.strchars(content) > 60 then content = vim.fn.strcharpart(content, 0, 57) .. "..." end
  return string.format("%s · %s · %s", record.id, location, content)
end

function M.overview(records, callback)
  if #records == 0 then
    vim.notify("Nvimotator has no pending annotations.", vim.log.levels.INFO)
    return
  end
  local items = {}
  for _, record in ipairs(records) do table.insert(items, record) end
  table.insert(items, { __overview_action = "clear", label = "Clear all annotations…" })
  return M.select(items, {
    prompt = "Nvimotator annotations",
    format_item = function(item)
      if item.__overview_action then return "◆ " .. item.label end
      return label(item)
    end,
  }, function(record)
    if not record then return end
    if record.__overview_action then
      callback(record.__overview_action, nil)
      return
    end
    local actions = {
      { id = "jump", label = "Jump to selection" },
      { id = "edit", label = "Edit comment" },
      { id = "delete", label = "Delete" },
      { id = "export", label = "Export all to clipboard" },
      { id = "send", label = "Send all feedback" },
    }
    if record.kind ~= "comment" then table.remove(actions, 2) end
    if not record.anchor then table.remove(actions, 1) end
    local _, select_error = M.select(actions, {
      prompt = "Nvimotator action",
      format_item = function(item) return item.label end,
    }, function(action)
      if action then callback(action.id, record) end
    end)
    if select_error then
      vim.notify("Could not open Nvimotator action picker: " .. select_error, vim.log.levels.ERROR)
    end
  end)
end

function M.confirm_clear(count, uncertain, callback)
  local warning = string.format("Clear %d pending annotation%s?", count, count == 1 and "" or "s")
  if uncertain then warning = warning .. " A submission acknowledgement is still uncertain." end
  return M.select({ "Cancel", "Clear" }, { prompt = warning }, function(choice)
    if choice == "Clear" then callback() end
  end)
end

function M.close()
  finish(nil)
end

function M.is_open()
  return active ~= nil
end

function M._active()
  return active
end

return M
