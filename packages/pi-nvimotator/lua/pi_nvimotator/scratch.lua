local M = {}

local function lines_for_text(text)
  local lines = vim.split(text, "\n", { plain = true })
  if #lines == 0 then
    return { "" }
  end
  return lines
end

local function line_bytes(bufnr, one_based_line)
  local line = vim.api.nvim_buf_get_lines(bufnr, one_based_line - 1, one_based_line, true)[1] or ""
  return #line
end

function M.open(bridge_id, snapshot)
  local name = string.format("nvimotator://%d/%s", bridge_id, snapshot.snapshotId)
  local bufnr
  for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(candidate) and vim.api.nvim_buf_get_name(candidate) == name then
      bufnr = candidate
      break
    end
  end
  if not bufnr then
    bufnr = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(bufnr, name)
  end
  vim.bo[bufnr].buftype = "nofile"
  vim.bo[bufnr].buflisted = false
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].undofile = false
  local filetype = "markdown"
  if snapshot.kind == "file" and type(snapshot.filePath) == "string" and snapshot.filePath ~= "" then
    local matched = vim.filetype.match({ filename = snapshot.filePath })
    if type(matched) == "string" and matched ~= "" then
      filetype = matched
    end
  end
  vim.bo[bufnr].filetype = filetype
  vim.bo[bufnr].readonly = false
  vim.bo[bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, true, lines_for_text(snapshot.text))
  vim.bo[bufnr].modified = false
  vim.bo[bufnr].modifiable = false
  vim.bo[bufnr].readonly = true
  vim.api.nvim_set_current_buf(bufnr)
  return bufnr
end

function M.line_anchor(bufnr, first_line, last_line)
  local line_count = vim.api.nvim_buf_line_count(bufnr)
  local first = math.max(1, math.min(first_line, line_count))
  local last = math.max(first, math.min(last_line, line_count))
  return {
    selection = "line",
    startLine = first,
    startByte = 0,
    endLine = last,
    endByte = line_bytes(bufnr, last),
  }
end

local function utf8_character_length(line, zero_based_column)
  if zero_based_column >= #line then
    return 0
  end
  local byte = line:byte(zero_based_column + 1)
  if not byte then return 0 end
  if byte < 0x80 then return 1 end
  if byte < 0xE0 then return 2 end
  if byte < 0xF0 then return 3 end
  return 4
end

local function before(left_line, left_col, right_line, right_col)
  return left_line < right_line or (left_line == right_line and left_col <= right_col)
end

function M.visual_anchor(bufnr)
  local active_mode = vim.fn.mode(1)
  local visual_mode = active_mode
  local left, right
  if active_mode == "v" or active_mode == "V" or active_mode == "\022" then
    left = vim.fn.getpos("v")
    right = vim.fn.getpos(".")
  else
    visual_mode = vim.fn.visualmode()
    left = vim.fn.getpos("'<")
    right = vim.fn.getpos("'>")
  end
  if visual_mode == "\022" then
    return nil, "Blockwise visual selections are not supported."
  end
  local left_line, left_col = left[2], math.max(left[3] - 1, 0)
  local right_line, right_col = right[2], math.max(right[3] - 1, 0)
  if not before(left_line, left_col, right_line, right_col) then
    left_line, right_line = right_line, left_line
    left_col, right_col = right_col, left_col
  end
  if visual_mode == "V" then
    return M.line_anchor(bufnr, left_line, right_line)
  end
  if visual_mode ~= "v" then
    return nil, "Only characterwise and linewise visual selections are supported."
  end

  local end_line_text = vim.api.nvim_buf_get_lines(bufnr, right_line - 1, right_line, true)[1] or ""
  local end_byte = right_col
  if vim.o.selection ~= "exclusive" then
    end_byte = math.min(#end_line_text, right_col + utf8_character_length(end_line_text, right_col))
  end
  if left_line == right_line and end_byte < left_col then
    end_byte = left_col
  end
  return {
    selection = "character",
    startLine = left_line,
    startByte = left_col,
    endLine = right_line,
    endByte = end_byte,
  }
end

return M
