local package_root = assert(vim.env.PI_NVIMOTATOR_PACKAGE)
local test_root = assert(vim.env.PI_NVIMOTATOR_TEST_ROOT)
local uv = vim.uv or vim.loop

local function eq(actual, expected, label)
  if not vim.deep_equal(actual, expected) then
    error(string.format("%s\nexpected: %s\nactual: %s", label or "values differ", vim.inspect(expected), vim.inspect(actual)))
  end
end

local function ok(value, label)
  if not value then error(label or "assertion failed") end
end

local function window_footer(window)
  local footer = vim.api.nvim_win_get_config(window).footer
  if type(footer) == "string" then return footer end
  if type(footer) ~= "table" then return tostring(footer or "") end
  local parts = {}
  for _, chunk in ipairs(footer) do
    if type(chunk) == "string" then
      parts[#parts + 1] = chunk
    elseif type(chunk) == "table" then
      parts[#parts + 1] = tostring(chunk[1] or "")
    end
  end
  return table.concat(parts)
end

-- Same IDs/labels/order as src/protocol.ts QUICK_ACTIONS (emoji-prefixed names).
local plannotator_quick_actions = {
  { id = "deletion", label = "Deletion" },
  { id = "thumbs-up", label = "👍 Looks good" },
  { id = "clarify-this", label = "❓ Clarify this" },
  { id = "missing-overview", label = "🗺️ Missing overview" },
  { id = "verify-this", label = "🔍 Verify this" },
  { id = "give-me-an-example", label = "🔬 Give me an example" },
  { id = "match-existing-patterns", label = "🧬 Match existing patterns" },
  { id = "consider-alternatives", label = "🔄 Consider alternatives" },
  { id = "ensure-no-regression", label = "📉 Ensure no regression" },
  { id = "out-of-scope", label = "🚫 Out of scope" },
  { id = "needs-tests", label = "🧪 Needs tests" },
  { id = "nice-approach", label = "👍 Nice approach" },
}

local scratch = require("pi_nvimotator.scratch")
local annotations = require("pi_nvimotator.annotations")
local draft = require("pi_nvimotator.draft")
local protocol = require("pi_nvimotator.protocol")
local modal = require("pi_nvimotator.modal")
local layout = require("pi_nvimotator.layout")
local registry = require("pi_nvimotator.registry")

ok(vim.fn.exists(":NvimotatorAttach") == 2, "plugin commands were not loaded")
ok(vim.fn.maparg("\\ng", "n") ~= "", "global-comment leader mapping was not installed")
ok(vim.fn.maparg("\\nt", "n") ~= "", "attach leader mapping was not installed")
eq(vim.g.pi_nvimotator_owns_registrations, 1, "plugin registration ownership marker")
vim.g.loaded_pi_nvimotator = nil
vim.g.pi_nvimotator_owns_registrations = nil
vim.cmd("runtime plugin/pi_nvimotator.lua")
ok(vim.fn.exists(":NvimotatorAttach") == 2, "legacy registration reload keeps commands")
ok(vim.fn.maparg("<Plug>(NvimotatorQuick)", "n") ~= "", "legacy registration reload keeps Plug mappings")
eq(vim.g.pi_nvimotator_owns_registrations, 1, "legacy reload claims registrations")
ok(vim.fn.maparg("<Plug>(NvimotatorAttach)", "n") ~= "", "legacy registration reload keeps attach Plug mapping")
vim.g.loaded_pi_nvimotator = nil
vim.cmd("runtime plugin/pi_nvimotator.lua")
ok(vim.fn.exists(":NvimotatorAttach") == 2, "owned repeated source keeps commands")

local snapshot = {
  snapshotId = "snapshot-headless",
  text = "alpha\nemoji 🙂 z\nomega\n",
}
local bufnr = scratch.open(16, snapshot)
eq(table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, true), "\n"), snapshot.text, "scratch buffer bytes")
eq(vim.bo[bufnr].buftype, "nofile", "buftype")
eq(vim.bo[bufnr].filetype, "markdown", "filetype")
eq(vim.bo[bufnr].modifiable, false, "modifiable")
eq(vim.bo[bufnr].readonly, true, "readonly")
eq(vim.bo[bufnr].swapfile, false, "swapfile")
eq(vim.bo[bufnr].undofile, false, "undofile")
local reattached = scratch.open(16, snapshot)
eq(reattached, bufnr, "same-snapshot reattach reuses the scratch buffer")

local returned_comment
local source_window = vim.api.nvim_get_current_win()
local source_bytes_before_modal = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, true), "\n")
local source_line_count_before_modal = vim.api.nvim_buf_line_count(bufnr)
local source_cursor_before_modal = vim.api.nvim_win_get_cursor(source_window)
local source_view_before_modal = vim.api.nvim_win_call(source_window, function() return vim.fn.winsaveview() end)
local comment_window, comment_error = modal.comment({
  title = "Headless comment",
  source_window = source_window,
  target_line = 2,
}, function(value) returned_comment = value end)
ok(comment_window, comment_error)
eq(vim.api.nvim_win_get_config(comment_window).relative, "editor", "comment editor float")
local active_comment = assert(modal._active(), "comment layout lease")
eq(active_comment.lease.kind, "float", "comment uses displaced float")
local comment_config = vim.api.nvim_win_get_config(comment_window)
local outer_top = comment_config.row + 1
local outer_bottom = outer_top + comment_config.height + 1
for line = 1, vim.api.nvim_buf_line_count(bufnr) do
  local position = vim.fn.screenpos(source_window, line, 1)
  if position.row > 0 then
    ok(position.row < outer_top or position.row > outer_bottom, "real source line is not beneath the comment float")
  end
end
local displacement_marks = vim.api.nvim_buf_get_extmarks(bufnr, layout.namespace(), 0, -1, { details = true })
eq(#displacement_marks, 1, "comment has one displacement lease")
eq(#displacement_marks[1][4].virt_lines, comment_config.height + 2, "displacement reserves the bordered float height")
eq(vim.api.nvim_buf_line_count(bufnr), source_line_count_before_modal, "displacement does not add buffer lines")
eq(table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, true), "\n"), source_bytes_before_modal,
  "displacement does not change source bytes")
local comment_buffer = vim.api.nvim_win_get_buf(comment_window)
eq(vim.bo[comment_buffer].filetype, "markdown", "comment editor filetype")
vim.api.nvim_buf_set_lines(comment_buffer, 0, -1, false, { "first line", "second line" })
local submit_comment = vim.api.nvim_replace_termcodes("<C-s>", true, false, true)
vim.api.nvim_feedkeys(submit_comment, "mx", false)
ok(vim.wait(1000, function() return returned_comment ~= nil end), "comment editor submit callback")
eq(returned_comment, "first line\nsecond line", "multiline comment editor result")
eq(modal.is_open(), false, "comment editor closed after submit")
eq(vim.api.nvim_get_current_win(), source_window, "comment editor restored source window")
eq(#vim.api.nvim_buf_get_extmarks(bufnr, layout.namespace(), 0, -1, {}), 0, "comment cleanup removes displacement")
eq(vim.api.nvim_win_get_cursor(source_window), source_cursor_before_modal, "comment cleanup restores source cursor")
local restored_source_view = vim.api.nvim_win_call(source_window, function() return vim.fn.winsaveview() end)
eq(restored_source_view.topline, source_view_before_modal.topline, "comment cleanup restores source topline")
eq(restored_source_view.leftcol, source_view_before_modal.leftcol, "comment cleanup restores horizontal view")

local paste_result
local paste_window, paste_error = modal.comment({
  title = "Paste comment",
  source_window = source_window,
  target_line = 2,
}, function(value) paste_result = value == nil and "<nil>" or value end)
ok(paste_window, paste_error)
local paste_buffer = vim.api.nvim_win_get_buf(paste_window)
eq(vim.bo[paste_buffer].buftype, "nofile", "comment editor is a scratch buffer")
eq(vim.fn.maparg("<Esc>", "i", false, false), "", "comment editor has no insert Esc mapping")
eq(vim.fn.maparg("<Esc>", "n", false, false), "", "comment editor has no normal Esc mapping")
eq(vim.fn.maparg("<C-[>", "n", false, false), "", "comment editor has no C-[ mapping")
local paste_ok, paste_err = pcall(vim.api.nvim_paste, "via nvim_paste", true, -1)
ok(paste_ok, tostring(paste_err))
eq(vim.api.nvim_buf_get_lines(paste_buffer, 0, -1, false), { "via nvim_paste" }, "nvim_paste inserts into the comment editor")
ok(modal.is_open(), "nvim_paste does not close the comment editor")
vim.api.nvim_buf_set_lines(paste_buffer, 0, -1, false, { "" })
paste_ok, paste_err = pcall(function()
  vim.api.nvim_paste("via ", false, 1)
  vim.api.nvim_paste("bracketed paste", false, 2)
  vim.api.nvim_paste("", false, 3)
end)
ok(paste_ok, tostring(paste_err))
eq(vim.api.nvim_buf_get_lines(paste_buffer, 0, -1, false), { "via bracketed paste" },
  "streamed nvim_paste matches terminal bracketed paste")
ok(modal.is_open(), "streamed paste does not close the comment editor")
-- Headless feedkeys has no TUI paste detector, so CSI 200~ is raw Esc+[... .
-- The bug was that mapped insert Esc cancelled; unmapped Esc must not close.
vim.api.nvim_feedkeys("i" .. "\x1b[200~ignored-in-headless\x1b[201~", "mtx", false)
ok(modal.is_open(), "bracketed-paste CSI prefix does not cancel the comment editor")
vim.api.nvim_buf_set_lines(paste_buffer, 0, -1, false, { "via bracketed paste" })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "mtx", false)
ok(modal.is_open(), "insert Esc does not cancel the comment editor")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "mtx", false)
ok(modal.is_open(), "normal Esc does not cancel the comment editor")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-[>", true, false, true), "mtx", false)
ok(modal.is_open(), "C-[ does not cancel the comment editor")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-s>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return paste_result ~= nil end), "comment submit after paste")
eq(paste_result, "via bracketed paste", "submit keeps pasted comment text")
eq(modal.is_open(), false, "comment editor closed after paste submit")

local selected_quick_action
local quick_actions = {
  { id = "deletion", label = "Deletion", description = "I don't want this in the message." },
  { id = "missing-overview", label = "🗺️ Missing overview", description = "A deliberately long agent-facing tip." },
}
local quick_window, quick_error = modal.quick(quick_actions, function(action) selected_quick_action = action end)
ok(quick_window, quick_error)
local quick_buffer = vim.api.nvim_win_get_buf(quick_window)
eq(vim.api.nvim_buf_get_lines(quick_buffer, 0, -1, false), { "Deletion", "🗺️ Missing overview" },
  "owned quick picker keeps compact labels")
vim.api.nvim_win_set_cursor(quick_window, { 2, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return selected_quick_action ~= nil end), "quick picker callback")
eq(selected_quick_action.id, "missing-overview", "quick picker returns the full selected action")
eq(#vim.api.nvim_buf_get_extmarks(bufnr, layout.namespace(), 0, -1, {}), 0, "quick picker cleanup removes displacement")

local cancelled_quick = "unset"
local notify_notes = {}
local original_notify = vim.notify
vim.notify = function(message, ...)
  notify_notes[#notify_notes + 1] = tostring(message)
  return original_notify(message, ...)
end
local cancel_quick_window, cancel_quick_error = modal.quick(quick_actions, function(action)
  cancelled_quick = action
end)
ok(cancel_quick_window, cancel_quick_error)
local visual_enter = vim.fn.maparg("<CR>", "x", false, true)
ok(type(visual_enter) == "table" and visual_enter.lhs ~= nil, "picker maps Enter in visual mode")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-c>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return not modal.is_open() end), "quick picker C-c closes")
vim.wait(50)
eq(cancelled_quick, "unset", "quick cancel does not invoke the selection callback")
for _, note in ipairs(notify_notes) do
  ok(not note:lower():find("invalid", 1, true), "quick cancel does not warn: " .. note)
end

local filtered_action = "unset"
local filter_window, filter_error = modal.quick(plannotator_quick_actions, function(action)
  filtered_action = action
end)
ok(filter_window, filter_error)
eq(#vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(filter_window), 0, -1, false), 12,
  "empty filter shows every default quick action")
ok(window_footer(filter_window):find("type to filter", 1, true), "idle picker footer hints typing filters")
vim.api.nvim_set_current_win(filter_window)
vim.api.nvim_feedkeys("L", "mx", false)
eq(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(filter_window), 0, -1, false), { "👍 Looks good" },
  "prefix L leaves only Looks good among default actions")
eq(modal._active().filter_query, "l", "L is a case-insensitive prefix query")
eq(#modal._active().filtered, 1, "filtered list has one row")
eq(modal._active().filtered[1].item.id, "thumbs-up", "filtered row keeps the original action object")
ok(window_footer(filter_window):find("filter:", 1, true), "active filter is shown in the footer")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return filtered_action ~= "unset" end), "filtered Enter invokes the callback")
eq(filtered_action.id, "thumbs-up", "filtered Enter selects Looks good, not a stale index")

local nomatch_action = "unset"
local nomatch_window, nomatch_error = modal.quick(plannotator_quick_actions, function(action)
  nomatch_action = action
end)
ok(nomatch_window, nomatch_error)
vim.api.nvim_set_current_win(nomatch_window)
vim.api.nvim_feedkeys("z", "mx", false)
eq(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(nomatch_window), 0, -1, false), { "(no matches)" },
  "non-matching prefix shows a placeholder")
eq(#modal._active().filtered, 0, "non-matching prefix has no selectable rows")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
vim.wait(50)
ok(modal.is_open(), "Enter on no matches does not close the picker")
eq(nomatch_action, "unset", "Enter on no matches does not select garbage")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<BS>", true, false, true), "mx", false)
eq(#vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(nomatch_window), 0, -1, false), 12,
  "Backspace restores the full list")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-c>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return not modal.is_open() end), "filter picker C-c closes")
vim.wait(50)
eq(nomatch_action, "unset", "filter picker cancel still nil-guards")

local nvimotator = require("pi_nvimotator")
local quick_store = annotations.Store.new(bufnr, function() end)
local plugin_state = nvimotator._state()
local saved_plugin_state = {
  phase = plugin_state.phase,
  store = plugin_state.store,
  bufnr = plugin_state.bufnr,
  actions = plugin_state.actions,
  generation = plugin_state.generation,
  snapshot = plugin_state.snapshot,
}
plugin_state.phase = "ready"
plugin_state.store = quick_store
plugin_state.bufnr = bufnr
plugin_state.actions = quick_actions
plugin_state.generation = 1
plugin_state.snapshot = {
  instanceId = "instance-quick",
  sessionId = "session-quick",
  snapshotId = "snapshot-headless",
  entryId = "entry-quick",
  messageHash = string.rep("b", 64),
}
notify_notes = {}
vim.api.nvim_set_current_win(source_window)
nvimotator.quick_range(2, 2)
ok(modal.is_open(), "quick_range opens the owned picker")
eq(modal._active().lease.target_line, 2, "quick_range displaces at the range end")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-c>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return not modal.is_open() end), "quick_range C-c closes")
vim.wait(50)
eq(quick_store:count(), 0, "quick_range cancel does not add an annotation")
for _, note in ipairs(notify_notes) do
  ok(not note:find("quick action is invalid", 1, true), "quick_range cancel stays silent: " .. note)
end

vim.api.nvim_set_current_win(source_window)
vim.api.nvim_win_set_cursor(source_window, { 2, 0 })
vim.cmd("normal! V")
nvimotator.quick_visual()
ok(modal.is_open(), "quick_visual opens from linewise visual")
eq(vim.fn.mode(1):sub(1, 1), "n", "quick picker leaves visual mode")
local visual_picker = assert(modal._active(), "visual quick picker")
vim.api.nvim_win_set_cursor(visual_picker.lease.window, { 1, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return quick_store:count() == 1 end), "visual quick Enter saves the action")
eq(quick_store:list()[1].actionId, "deletion", "visual quick stores the selected action")
quick_store:clear()

plugin_state.actions = plannotator_quick_actions
notify_notes = {}
vim.api.nvim_set_current_win(source_window)
nvimotator.quick_range(2, 2)
ok(modal.is_open(), "quick_range opens the default-action picker")
vim.api.nvim_set_current_win(modal._active().lease.window)
vim.api.nvim_feedkeys("L", "mx", false)
eq(vim.api.nvim_buf_get_lines(modal._active().buffer, 0, -1, false), { "👍 Looks good" },
  "quick_range prefix L leaves only Looks good")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return quick_store:count() == 1 end), "filtered Enter saves the action")
eq(quick_store:list()[1].actionId, "thumbs-up", "filtered Enter add_action stores Looks good")
for _, note in ipairs(notify_notes) do
  ok(not note:find("quick action is invalid", 1, true), "filtered save stays silent: " .. note)
end
quick_store:clear()
plugin_state.actions = quick_actions

vim.cmd("belowright 20new")
local probe_win = vim.api.nvim_get_current_win()
local probe_buf = vim.api.nvim_get_current_buf()
local many_lines = {}
for i = 1, 80 do many_lines[i] = "line " .. i end
vim.bo[probe_buf].buftype = "nofile"
vim.api.nvim_buf_set_lines(probe_buf, 0, -1, true, many_lines)
vim.wo[probe_win].scrolloff = 10
vim.api.nvim_win_set_cursor(probe_win, { 80, 0 })
local last_window, last_error = modal.quick(quick_actions, function() end, {
  source_window = probe_win,
  target_line = 80,
})
ok(last_window, last_error)
ok(modal.is_open(), "last-line picker opens under scrolloff")
local last_lease = modal._active().lease
if last_lease.kind == "float" then
  eq(vim.wo[probe_win].scrolloff, 0, "float layout pins scrolloff while open")
end
modal.close()
ok(vim.wait(1000, function() return not modal.is_open() end), "last-line picker closes")
eq(vim.wo[probe_win].scrolloff, 10, "layout restores scrolloff after last-line picker")
if vim.api.nvim_win_is_valid(probe_win) then vim.api.nvim_win_close(probe_win, true) end
vim.api.nvim_set_current_win(source_window)

plugin_state.phase = saved_plugin_state.phase
plugin_state.store = saved_plugin_state.store
plugin_state.bufnr = saved_plugin_state.bufnr
plugin_state.actions = saved_plugin_state.actions
plugin_state.generation = saved_plugin_state.generation
plugin_state.snapshot = saved_plugin_state.snapshot
vim.notify = original_notify

local line_anchor = scratch.line_anchor(bufnr, 2, 3)
eq(line_anchor, {
  selection = "line", startLine = 2, startByte = 0, endLine = 3, endByte = 5,
}, "line anchor")

vim.api.nvim_win_set_cursor(0, { 2, 6 })
vim.cmd([[normal! v]])
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "x", false)
local character_anchor, visual_error = scratch.visual_anchor(bufnr)
ok(character_anchor, visual_error)
eq(character_anchor.selection, "character", "visual selection kind")
eq(character_anchor.startLine, 2, "visual start line")
eq(character_anchor.startByte, 6, "visual start byte")
eq(character_anchor.endLine, 2, "visual end line")
eq(character_anchor.endByte, 10, "emoji end-exclusive UTF-8 byte")

local changed = 0
local store = annotations.Store.new(bufnr, function() changed = changed + 1 end)
local comment_id = store:add_comment(line_anchor, "Needs detail")
local action_id = store:add_action(character_anchor, { id = "thumbs-up", label = "👍 Looks good" })
eq(store:count(), 2, "annotation count")
eq(changed, 2, "change callbacks")
local oversized_id, oversized_error = store:add_comment(line_anchor, string.rep("x", 16 * 1024 + 1))
eq(oversized_id, nil, "oversized comment rejected")
ok(oversized_error:match("16384"), "oversized comment error")
eq(store:count(), 2, "oversized comment does not mutate state")
ok(#vim.api.nvim_buf_get_extmarks(bufnr, store.namespace, 0, -1, {}) == 2, "extmarks")
ok(store:jump(comment_id), "jump to annotation")
eq(vim.api.nvim_win_get_cursor(0)[1], 2, "jump line")
ok(store:delete(action_id), "delete quick action")
eq(store:count(), 1, "annotation deletion")

local function global_panel_text()
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(bufnr, store.namespace, 0, -1, { details = true })) do
    local virtual_lines = mark[4] and mark[4].virt_lines
    if virtual_lines then
      local rendered = {}
      for _, virtual_line in ipairs(virtual_lines) do
        local chunks = {}
        for _, chunk in ipairs(virtual_line) do table.insert(chunks, chunk[1]) end
        table.insert(rendered, table.concat(chunks))
      end
      return table.concat(rendered, "\n")
    end
  end
end

local global_id = store:add_comment(nil, "Overall feedback.\nSecond line")
ok(global_panel_text():match("Global feedback %(1%)"), "global panel count")
ok(global_panel_text():match("Overall feedback%."), "global panel summary")
ok(global_panel_text():match("\\ng add · \\nc manage"), "global panel mapping hint")
ok(store:edit(global_id, "Updated global feedback"), "edit global comment")
ok(global_panel_text():match("Updated global feedback"), "global panel edit refresh")
ok(store:delete(global_id), "delete global comment")
eq(global_panel_text(), nil, "global panel hidden after last global deletion")

store:add_comment(nil, "Restored global feedback")
local records_with_global = store:list()
store:clear()
eq(global_panel_text(), nil, "global panel hidden after clear")
store:replace(records_with_global)
ok(global_panel_text():match("Restored global feedback"), "global panel restored from draft records")
eq(table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, true), "\n"), snapshot.text, "global panel does not alter snapshot bytes")

local selected_overview_action
local selected_overview_record = "unset"
local overview_window, overview_error = modal.overview(store:list(), function(action, record)
  selected_overview_action = action
  selected_overview_record = record
end)
ok(overview_window, overview_error)
local overview_buffer = vim.api.nvim_win_get_buf(overview_window)
local overview_lines = vim.api.nvim_buf_get_lines(overview_buffer, 0, -1, false)
eq(overview_lines[#overview_lines], "◆ Clear all annotations…", "comments overview clear-all label")
vim.api.nvim_win_set_cursor(overview_window, { #overview_lines, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return selected_overview_action ~= nil end), "comments overview callback")
eq(selected_overview_action, "clear", "comments overview clear-all action")
eq(selected_overview_record, nil, "clear-all is not tied to one annotation")

local confirmed = false
local confirm_window, confirm_error = modal.confirm_clear(2, false, function() confirmed = true end)
ok(confirm_window, confirm_error)
vim.api.nvim_win_set_cursor(confirm_window, { 2, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return confirmed end), "owned confirmation callback")
eq(#vim.api.nvim_buf_get_extmarks(bufnr, layout.namespace(), 0, -1, {}), 0, "confirmation cleanup removes displacement")

local original_attach = nvimotator.attach
local prompted_id
nvimotator.attach = function(value) prompted_id = value end
local attach_source = vim.api.nvim_get_current_win()
nvimotator.attach_prompt()
local attach_modal = assert(modal._active(), "owned attach input")
local attach_buffer = attach_modal.buffer
vim.bo[attach_buffer].modifiable = true
vim.api.nvim_buf_set_lines(attach_buffer, 0, -1, false, { " 16 " })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return prompted_id ~= nil end), "attach input callback")
eq(prompted_id, "16", "prompted attach trims and forwards the bridge ID")
eq(vim.api.nvim_get_current_win(), attach_source, "attach input restores source window")
prompted_id = nil
nvimotator.attach_prompt()
ok(modal.is_open(), "attach input reopened")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "mx", false)
ok(modal.is_open(), "attach input Esc does not cancel")
eq(prompted_id, nil, "Esc does not submit the attach prompt")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-c>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return not modal.is_open() end), "attach input C-c cancel closes")
eq(prompted_id, nil, "cancelled attach prompt does nothing")
nvimotator.attach = original_attach

vim.cmd("belowright 3new")
local tiny_source = vim.api.nvim_get_current_win()
pcall(vim.api.nvim_win_set_height, tiny_source, 3)
local tiny_window, tiny_error = modal.input({ prompt = "Tiny", source_window = tiny_source }, function() end)
ok(tiny_window, tiny_error)
eq(modal._active().lease.kind, "split", "tiny source window uses non-overlapping split fallback")
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<C-c>", true, false, true), "mx", false)
ok(vim.wait(1000, function() return not modal.is_open() end), "split fallback closes")
if vim.api.nvim_win_is_valid(tiny_source) then vim.api.nvim_win_close(tiny_source, true) end
vim.api.nvim_set_current_win(source_window)
local nvimotator_state = nvimotator._state()
nvimotator_state.phase = "ready"
nvimotator_state.store = store
nvimotator_state.bufnr = bufnr
nvimotator_state.pending = nil
nvimotator_state.snapshot = {
  instanceId = "instance-clear-test",
  sessionId = "session-clear-test",
  snapshotId = "snapshot-clear-test",
  entryId = "entry-clear-test",
  messageHash = string.rep("c", 64),
}
local original_overview = modal.overview
local original_confirm_clear = modal.confirm_clear
local confirmed_clear_count
modal.overview = function(_, callback) callback("clear", nil) end
modal.confirm_clear = function(count, uncertain, callback)
  confirmed_clear_count = count
  eq(uncertain, false, "overview clear uncertainty")
  callback()
end
nvimotator.comments()
modal.overview = original_overview
modal.confirm_clear = original_confirm_clear
eq(confirmed_clear_count, #records_with_global, "overview clear confirmation count")
eq(store:count(), 0, "overview clear removes all annotations")
store:replace(records_with_global)

local wire = protocol.wire_annotations({
  { id = "quick", kind = "quickAction", anchor = character_anchor, actionId = "deletion", actionLabel = "not on wire", excerpt = "not on wire" },
})
eq(wire[1].actionLabel, nil, "server owns action labels")
eq(wire[1].excerpt, nil, "client excerpts stay off wire")
local _, deterministic_error = protocol.validate_response({
  ok = false, message = "invalid anchor", code = "invalid_request", retryable = false,
}, {}, "rendered")
eq(protocol.error_message(deterministic_error), "invalid anchor", "structured bridge error message")
eq(protocol.is_retryable(deterministic_error), false, "deterministic bridge error retryability")

local identity = {
  instanceId = "instance-headless",
  sessionId = "session-headless",
  snapshotId = "snapshot-headless",
  entryId = "entry-headless",
  messageHash = string.rep("a", 64),
}
local saved, save_error = draft.save(identity, store:list(), {
  id = "submission-retry", fingerprint = "fingerprint", annotations = store:list(),
})
ok(saved, save_error)
local draft_path = draft.path_for(identity)
local fd = assert(uv.fs_open(draft_path, "r", 384))
local stat = assert(uv.fs_fstat(fd))
local draft_bytes = assert(uv.fs_read(fd, stat.size, 0))
uv.fs_close(fd)
ok(not draft_bytes:find("token", 1, true), "draft must not contain token fields")
eq(stat.mode % 512, 384, "draft mode")
local restored, restore_error = draft.load(identity)
ok(restored, restore_error)
eq(restored.annotations[1].comment, "Needs detail", "draft restore")
eq(restored.pendingSubmission.id, "submission-retry", "pending submission ID restore")
eq(restored.pendingSubmission.annotations[1].comment, "Needs detail", "pending annotation restore")
ok(draft.delete(identity), "draft delete")

local registry_dir = assert(vim.env.PI_NVIMOTATOR_REGISTRY)
vim.fn.mkdir(registry_dir, "p", 448)
uv.fs_chmod(registry_dir, 448)
local manifest = {
  protocolVersion = 2,
  bridgeId = 16,
  instanceId = "instance-headless",
  sessionId = "session-headless",
  snapshotId = "snapshot-headless",
  entryId = "entry-headless",
  messageHash = string.rep("a", 64),
  pid = vim.fn.getpid(),
  transport = "unix",
  socketPath = vim.fs.joinpath(registry_dir, "16.sock"),
  token = "secret-token",
  startedAt = "2026-01-01T00:00:00.000Z",
}
local live_pipe = assert(uv.new_pipe(false))
assert(live_pipe:bind(manifest.socketPath))
assert(live_pipe:listen(1, function() end))
uv.fs_chmod(manifest.socketPath, 384)
local manifest_path = vim.fs.joinpath(registry_dir, "16.json")
vim.fn.writefile({ vim.json.encode(manifest) }, manifest_path, "b")
uv.fs_chmod(manifest_path, 384)
local looked_up, lookup_error = registry.lookup("16")
ok(looked_up, lookup_error)
eq(looked_up.bridgeId, 16, "registry ID")
eq(select(1, registry.lookup("016")), nil, "noncanonical registry ID")

manifest.bridgeId = 17
manifest.pid = 99999999
manifest.socketPath = vim.fs.joinpath(registry_dir, "17.sock")
local stale_pipe = assert(uv.new_pipe(false))
assert(stale_pipe:bind(manifest.socketPath))
assert(stale_pipe:listen(1, function() end))
uv.fs_chmod(manifest.socketPath, 384)
local stale_path = vim.fs.joinpath(registry_dir, "17.json")
vim.fn.writefile({ vim.json.encode(manifest) }, stale_path, "b")
uv.fs_chmod(stale_path, 384)
local stale, stale_error = registry.lookup("17")
eq(stale, nil, "stale pid rejected")
ok(stale_error:match("not running"), "stale pid error")
eq(uv.fs_lstat(stale_path), nil, "stale manifest removed")
eq(uv.fs_lstat(manifest.socketPath), nil, "stale Unix socket removed")
stale_pipe:close()

manifest.protocolVersion = 1
manifest.bridgeId = 18
manifest.pid = vim.fn.getpid()
manifest.transport = nil
manifest.socketPath = nil
manifest.host = "127.0.0.1"
manifest.port = 32123
local legacy_path = vim.fs.joinpath(registry_dir, "18.json")
vim.fn.writefile({ vim.json.encode(manifest) }, legacy_path, "b")
uv.fs_chmod(legacy_path, 384)
local legacy, legacy_error = registry.lookup("18")
eq(legacy, nil, "live legacy protocol rejected")
ok(legacy_error:match("protocol 1"), "legacy protocol migration guidance")
ok(uv.fs_lstat(legacy_path), "live legacy manifest is not deleted")
uv.fs_unlink(legacy_path)

live_pipe:close()
pcall(uv.fs_unlink, vim.fs.joinpath(registry_dir, "16.sock"))
print("pi-nvimotator headless tests passed")
