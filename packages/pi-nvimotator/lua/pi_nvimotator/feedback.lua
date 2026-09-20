-- File-store wrap. Keep aligned with packages/pi-nvimotator/src/feedback.ts.
local M = {}

local MAX_EXCERPT_BYTES = 64 * 1024
local MAX_TOTAL_EXCERPT_BYTES = 256 * 1024
local MAX_SELECTED_LINES = 1000
local MAX_PROMPT_BYTES = 512 * 1024

local function line_bytes(snapshot, one_based)
  return snapshot.lines[one_based] or ""
end

local function decode_slice(bytes, start_byte, end_byte)
  if start_byte > end_byte or end_byte > #bytes then
    return nil, "Annotation byte range is outside the selected line."
  end
  return bytes:sub(start_byte + 1, end_byte)
end

local function excerpt_for_anchor(snapshot, anchor)
  if anchor.startLine < 1 or anchor.endLine > #snapshot.lines or anchor.endLine < anchor.startLine then
    return nil, "Annotation line range is outside the captured snapshot."
  end
  if anchor.endLine - anchor.startLine + 1 > MAX_SELECTED_LINES then
    return nil, string.format("One annotation cannot span more than %d lines.", MAX_SELECTED_LINES)
  end
  local first = line_bytes(snapshot, anchor.startLine)
  local last = line_bytes(snapshot, anchor.endLine)
  if anchor.selection == "line" and (anchor.startByte ~= 0 or anchor.endByte ~= #last) then
    return nil, "Line selections must cover complete lines."
  end
  if anchor.startByte > #first or anchor.endByte > #last then
    return nil, "Annotation byte range is outside the selected text."
  end
  if anchor.startLine == anchor.endLine then
    if anchor.endByte < anchor.startByte then
      return nil, "Annotation end precedes its start."
    end
    local excerpt, err = decode_slice(first, anchor.startByte, anchor.endByte)
    if not excerpt then return nil, err end
    if #excerpt > MAX_EXCERPT_BYTES then return nil, "Selected excerpt is too large." end
    return excerpt
  end
  local selected = {}
  local head, head_err = decode_slice(first, anchor.startByte, #first)
  if not head then return nil, head_err end
  selected[#selected + 1] = head
  for line = anchor.startLine + 1, anchor.endLine - 1 do
    selected[#selected + 1] = snapshot.lines[line] or ""
  end
  local tail, tail_err = decode_slice(last, 0, anchor.endByte)
  if not tail then return nil, tail_err end
  selected[#selected + 1] = tail
  local excerpt = table.concat(selected, "\n")
  if #excerpt > MAX_EXCERPT_BYTES then return nil, "Selected excerpt is too large." end
  return excerpt
end

local function range_label(anchor)
  local lines = anchor.startLine == anchor.endLine
    and string.format("line %d", anchor.startLine)
    or string.format("lines %d-%d", anchor.startLine, anchor.endLine)
  if anchor.selection == "character" then
    return string.format("%s, bytes %d-%d", lines, anchor.startByte, anchor.endByte)
  end
  return lines
end

local function fence(text)
  local longest, current = 0, 0
  for i = 1, #text do
    if text:sub(i, i) == "`" then
      current = current + 1
      if current > longest then longest = current end
    else
      current = 0
    end
  end
  local marker = string.rep("`", math.max(3, longest + 1))
  return marker .. "markdown\n" .. text .. "\n" .. marker
end

local function quote(text)
  local lines = {}
  for line in (text .. "\n"):gmatch("(.-)\n") do
    lines[#lines + 1] = "> " .. line
  end
  return table.concat(lines, "\n")
end

local function action_map(actions)
  local map = {}
  for _, action in ipairs(actions or {}) do
    if type(action) == "table" and type(action.id) == "string" then
      map[action.id] = action
    end
  end
  return map
end

function M.build_raw(snapshot, annotations)
  local file = snapshot.kind == "file"
  local total = 0
  local lines = {
    file and "# File Feedback" or "# Message Feedback",
    "",
  }
  if file then
    lines[#lines + 1] = string.format("File: `%s`", snapshot.filePath or snapshot.entryId)
  else
    lines[#lines + 1] = string.format("Assistant entry: `%s`", snapshot.entryId)
  end
  lines[#lines + 1] = string.format("Snapshot: `%s`", snapshot.snapshotId)
  lines[#lines + 1] = ""
  local semantics = action_map(snapshot.quickActions)
  for index, annotation in ipairs(annotations) do
    local title = annotation.anchor and range_label(annotation.anchor) or "general"
    lines[#lines + 1] = string.format("## Annotation %d — %s", index, title)
    lines[#lines + 1] = ""
    if annotation.anchor then
      local excerpt, err = excerpt_for_anchor(snapshot, annotation.anchor)
      if not excerpt then return nil, err end
      total = total + #excerpt
      if total > MAX_TOTAL_EXCERPT_BYTES then
        return nil, "Combined selected excerpts are too large."
      end
      lines[#lines + 1] = file and "Selected file text:" or "Selected assistant text:"
      lines[#lines + 1] = ""
      lines[#lines + 1] = fence(excerpt)
      lines[#lines + 1] = ""
    end
    if annotation.kind == "comment" then
      lines[#lines + 1] = "User comment:"
      lines[#lines + 1] = quote(annotation.comment)
      lines[#lines + 1] = ""
    else
      local action = semantics[annotation.actionId]
      if not action then return nil, "Quick action is unsupported." end
      lines[#lines + 1] = "Quick action: " .. (action.label or annotation.actionId)
      if type(action.description) == "string" and action.description ~= "" then
        lines[#lines + 1] = quote(action.description)
      end
      lines[#lines + 1] = ""
    end
  end
  while lines[#lines] == "" do lines[#lines] = nil end
  return table.concat(lines, "\n")
end

function M.wrap(snapshot, raw)
  local target = "the last assistant message"
  if snapshot.kind == "file" and type(snapshot.filePath) == "string" and snapshot.filePath ~= "" then
    target = string.format("the local file `%s`", snapshot.filePath)
  end
  return table.concat({
    "This is user annotation feedback from Neovim on " .. target .. ".",
    "Incorporate the comments and quick actions below into your next reply.",
    "",
    raw,
  }, "\n")
end

function M.build_wrapped(snapshot, annotations)
  local raw, err = M.build_raw(snapshot, annotations)
  if not raw then return nil, err end
  local prompt = M.wrap(snapshot, raw)
  if #prompt > MAX_PROMPT_BYTES then
    return nil, string.format("Rendered feedback is larger than %d bytes.", MAX_PROMPT_BYTES)
  end
  return prompt
end

function M.wire_annotations(records)
  local result = {}
  for _, record in ipairs(records) do
    local item = { id = record.id, kind = record.kind }
    if record.anchor then item.anchor = vim.deepcopy(record.anchor) end
    if record.kind == "comment" then
      item.comment = record.comment
    else
      item.actionId = record.actionId
    end
    result[#result + 1] = item
  end
  return result
end

return M
