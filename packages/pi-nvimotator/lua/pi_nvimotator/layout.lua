local M = {}

local namespace = vim.api.nvim_create_namespace("pi_nvimotator_layout")
local lease_counter = 0

local function valid_window(window)
  return window and vim.api.nvim_win_is_valid(window)
end

local function valid_buffer(buffer)
  return buffer and vim.api.nvim_buf_is_valid(buffer)
end

local function blank_virtual_lines(count)
  local lines = {}
  for _ = 1, count do table.insert(lines, { { " ", "Normal" } }) end
  return lines
end

local function source_state(source_window, target_line)
  local source_buffer = vim.api.nvim_win_get_buf(source_window)
  local line_count = vim.api.nvim_buf_line_count(source_buffer)
  local cursor = vim.api.nvim_win_get_cursor(source_window)
  local target = math.max(1, math.min(target_line or cursor[1], line_count))
  local view = vim.api.nvim_win_call(source_window, function() return vim.fn.winsaveview() end)
  return source_buffer, target, cursor, view
end

local function restore_source(lease)
  if lease.extmark and valid_buffer(lease.source_buffer) then
    pcall(vim.api.nvim_buf_del_extmark, lease.source_buffer, namespace, lease.extmark)
    lease.extmark = nil
  end
  if not valid_window(lease.source_window) then return end
  if vim.api.nvim_win_get_buf(lease.source_window) ~= lease.source_buffer then return end
  pcall(vim.api.nvim_win_call, lease.source_window, function()
    pcall(vim.api.nvim_win_set_cursor, lease.source_window, lease.source_cursor)
    vim.fn.winrestview(lease.source_view)
  end)
end

local function open_split(buffer, options, lease)
  local previous = vim.api.nvim_get_current_win()
  vim.api.nvim_set_current_win(lease.source_window)
  local ok, split_error = pcall(vim.cmd, "belowright sbuffer " .. buffer)
  if not ok then
    if valid_window(previous) then pcall(vim.api.nvim_set_current_win, previous) end
    return nil, tostring(split_error)
  end
  local window = vim.api.nvim_get_current_win()
  local height = math.max(1, math.min(options.height or 8, math.floor(vim.o.lines / 2)))
  pcall(vim.api.nvim_win_set_height, window, height)
  lease.window = window
  lease.kind = "split"
  lease.height = vim.api.nvim_win_get_height(window)
  lease.width = vim.api.nvim_win_get_width(window)
  return lease
end

function M.open(buffer, options)
  options = options or {}
  local source_window = options.source_window
  if not valid_window(source_window) then source_window = vim.api.nvim_get_current_win() end
  local source_buffer, target_line, source_cursor, source_view = source_state(source_window, options.target_line)
  lease_counter = lease_counter + 1
  local lease = {
    id = lease_counter,
    source_window = source_window,
    source_buffer = source_buffer,
    source_cursor = source_cursor,
    source_view = source_view,
    target_line = target_line,
  }

  local window_height = vim.api.nvim_win_get_height(source_window)
  local window_width = vim.api.nvim_win_get_width(source_window)
  if window_height < 4 or window_width < 4 then return open_split(buffer, options, lease) end

  local height = math.max(1, math.min(options.height or 8, window_height - 3))
  local width = math.max(1, math.min(options.width or 72, window_width - 2))
  local occupied_rows = height + 2
  lease.extmark = vim.api.nvim_buf_set_extmark(source_buffer, namespace, target_line - 1, 0, {
    virt_lines = blank_virtual_lines(occupied_rows),
    virt_lines_above = false,
  })

  local positioned = pcall(vim.api.nvim_win_call, source_window, function()
    vim.api.nvim_win_set_cursor(source_window, { target_line, 0 })
    vim.cmd("normal! zt")
  end)
  if not positioned then
    restore_source(lease)
    return nil, "Could not position the Nvimotator source window."
  end

  local screen = vim.fn.screenpos(source_window, target_line, 1)
  local window_position = vim.api.nvim_win_get_position(source_window)
  if type(screen) ~= "table" or screen.row == 0 then
    restore_source(lease)
    return nil, "Could not locate the Nvimotator source line on screen."
  end
  local config = {
    relative = "editor",
    row = screen.row,
    col = window_position[2],
    width = width,
    height = height,
    style = "minimal",
    border = "rounded",
    title = options.title,
    title_pos = "center",
    footer = options.footer,
    footer_pos = "center",
    zindex = 60,
  }
  local ok, window = pcall(vim.api.nvim_open_win, buffer, true, config)
  if not ok then
    restore_source(lease)
    return nil, tostring(window)
  end
  lease.window = window
  lease.kind = "float"
  lease.height = height
  lease.width = width
  lease.occupied_rows = occupied_rows
  lease.config = config
  return lease
end

function M.close(lease)
  if not lease or lease.closed then return end
  lease.closed = true
  if valid_window(lease.window) then pcall(vim.api.nvim_win_close, lease.window, true) end
  restore_source(lease)
  if valid_window(lease.source_window) then pcall(vim.api.nvim_set_current_win, lease.source_window) end
end

function M.namespace()
  return namespace
end

return M
