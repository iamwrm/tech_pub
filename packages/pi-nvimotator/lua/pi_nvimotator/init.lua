local annotations = require("pi_nvimotator.annotations")
local client = require("pi_nvimotator.client")
local draft = require("pi_nvimotator.draft")
local modal = require("pi_nvimotator.modal")
local protocol = require("pi_nvimotator.protocol")
local registry = require("pi_nvimotator.registry")
local scratch = require("pi_nvimotator.scratch")

local M = {}
local config = {}
local state = { phase = "detached", generation = 0 }

local function notify(message, level)
  vim.notify(message, level or vim.log.levels.INFO, { title = "pi-nvimotator" })
end

local function identity()
  if not state.snapshot then return nil end
  return {
    instanceId = state.snapshot.instanceId,
    sessionId = state.snapshot.sessionId,
    snapshotId = state.snapshot.snapshotId,
    entryId = state.snapshot.entryId,
    messageHash = state.snapshot.messageHash,
  }
end

local function save_draft()
  if not state.store or not state.snapshot then return end
  local ok, err = draft.save(identity(), state.store:list(), state.pending)
  if not ok then notify(err, vim.log.levels.WARN) end
end

local function invalidate_submission()
  state.pending = nil
  save_draft()
end

local function ensure_ready(require_buffer)
  if state.phase ~= "ready" or not state.store then
    notify("Attach to a live bridge with :NvimotatorAttach <id> first.", vim.log.levels.WARN)
    return false
  end
  if require_buffer and vim.api.nvim_get_current_buf() ~= state.bufnr then
    notify("Annotations must be created from the Nvimotator snapshot buffer.", vim.log.levels.WARN)
    return false
  end
  return true
end

local function bridge_request(kind, submission, expected_type, callback)
  local request = protocol.base(state.manifest, kind)
  if submission then
    request.submissionId = submission.id
    if kind == "render" or kind == "submit" then
      request.annotations = protocol.wire_annotations(submission.annotations)
    end
  end
  local generation = state.generation
  client.request(state.manifest, request, function(response, request_error)
    if generation ~= state.generation then return end
    if request_error then
      callback(nil, request_error)
      return
    end
    local valid, validation_error = protocol.validate_response(response, state.manifest, expected_type)
    callback(valid, validation_error)
  end)
end

function M.attach(raw_id)
  state.generation = state.generation + 1
  local generation = state.generation
  state.phase = "attaching"
  local manifest, lookup_error = registry.lookup(raw_id)
  if not manifest then
    state.phase = "detached"
    notify(lookup_error, vim.log.levels.ERROR)
    return
  end
  local request = protocol.base(manifest, "snapshot")
  client.request(manifest, request, function(response, request_error)
    if generation ~= state.generation then return end
    if request_error then
      state.phase = "detached"
      notify(request_error, vim.log.levels.ERROR)
      return
    end
    local snapshot, validation_error = protocol.validate_response(response, manifest, "snapshot")
    if not snapshot or snapshot.entryId ~= manifest.entryId or snapshot.messageHash ~= manifest.messageHash
        or type(snapshot.text) ~= "string" or type(snapshot.quickActions) ~= "table" then
      state.phase = "detached"
      notify(validation_error and protocol.error_message(validation_error) or "Authenticated snapshot does not match the registry manifest.", vim.log.levels.ERROR)
      return
    end

    local previous = state.bufnr
    state.manifest = manifest
    state.snapshot = snapshot
    state.actions = snapshot.quickActions
    state.bufnr = scratch.open(manifest.bridgeId, snapshot)
    state.store = annotations.Store.new(state.bufnr, invalidate_submission)
    state.pending = nil
    state.scheduled_submission = nil
    local restored, restore_error = draft.load(identity())
    if restored then
      state.store:replace(restored.annotations)
      state.pending = restored.pendingSubmission
    elseif restore_error then
      notify(restore_error, vim.log.levels.WARN)
    end
    state.phase = "ready"
    if previous and previous ~= state.bufnr and vim.api.nvim_buf_is_valid(previous) then
      pcall(vim.api.nvim_buf_delete, previous, { force = true })
    end
    notify(string.format("Attached to Nvimotator %d with %d pending annotation%s.", manifest.bridgeId,
      state.store:count(), state.store:count() == 1 and "" or "s"))
  end)
end

function M.attach_prompt()
  local _, modal_error = modal.input({
    prompt = "Nvimotator bridge ID",
    source_window = vim.api.nvim_get_current_win(),
  }, function(value)
    if value == nil then return end
    value = vim.trim(value)
    if value == "" then return end
    M.attach(value)
  end)
  if modal_error then notify("Could not open attachment prompt: " .. modal_error, vim.log.levels.ERROR) end
end

local function add_comment(anchor, title)
  local generation = state.generation
  local _, modal_error = modal.comment({
    title = title,
    source_window = vim.api.nvim_get_current_win(),
    target_line = anchor and anchor.endLine or nil,
  }, function(comment)
    if comment == nil or generation ~= state.generation or not ensure_ready(false) then return end
    local id, add_error = state.store:add_comment(anchor, comment)
    if not id then notify(add_error, vim.log.levels.WARN) end
  end)
  if modal_error then notify("Could not open comment editor: " .. modal_error, vim.log.levels.ERROR) end
end

function M.annotate_range(first_line, last_line)
  if not ensure_ready(true) then return end
  add_comment(scratch.line_anchor(state.bufnr, first_line, last_line), "Nvimotator comment")
end

function M.annotate_visual()
  if not ensure_ready(true) then return end
  local anchor, anchor_error = scratch.visual_anchor(state.bufnr)
  if not anchor then notify(anchor_error, vim.log.levels.WARN); return end
  add_comment(anchor, "Nvimotator selection comment")
end

local function add_quick(anchor)
  local generation = state.generation
  local _, modal_error = modal.quick(state.actions, function(action)
    if not action or generation ~= state.generation or not ensure_ready(false) then return end
    local id, add_error = state.store:add_action(anchor, action)
    if not id then notify(add_error, vim.log.levels.WARN) end
  end, {
    source_window = vim.api.nvim_get_current_win(),
    target_line = anchor and anchor.endLine or nil,
  })
  if modal_error then notify("Could not open quick-action picker: " .. modal_error, vim.log.levels.ERROR) end
end

function M.quick_range(first_line, last_line)
  if not ensure_ready(true) then return end
  add_quick(scratch.line_anchor(state.bufnr, first_line, last_line))
end

function M.quick_visual()
  if not ensure_ready(true) then return end
  local anchor, anchor_error = scratch.visual_anchor(state.bufnr)
  if not anchor then notify(anchor_error, vim.log.levels.WARN); return end
  add_quick(anchor)
end

function M.comment()
  if not ensure_ready(false) then return end
  add_comment(nil, "Nvimotator global comment")
end

local function frozen_submission()
  if not ensure_ready(false) then return nil end
  if state.store:count() == 0 then
    notify("There are no annotations to send or export.", vim.log.levels.WARN)
    return nil
  end
  local records = state.store:list()
  local wire_records = protocol.wire_annotations(records)
  if state.pending and vim.deep_equal(protocol.wire_annotations(state.pending.annotations), wire_records) then
    return state.pending
  end
  local fingerprint = vim.fn.sha256(vim.json.encode(wire_records))
  state.pending = { id = protocol.submission_id(), fingerprint = fingerprint, annotations = records }
  save_draft()
  return state.pending
end

local function copy_to_clipboard(text)
  if type(config.clipboard) == "function" then
    return config.clipboard(text)
  end
  vim.fn.setreg("+", text, "v")
  return true
end

function M.export()
  local submission = frozen_submission()
  if not submission then return end
  state.phase = "rendering"
  bridge_request("render", submission, "rendered", function(response, request_error)
    state.phase = "ready"
    if not response then notify(protocol.error_message(request_error), vim.log.levels.ERROR); return end
    if response.submissionId ~= submission.id or response.annotationCount ~= #submission.annotations then
      notify("Rendered response does not match the frozen annotation set.", vim.log.levels.ERROR)
      return
    end
    local ok, clipboard_error = pcall(copy_to_clipboard, response.prompt)
    if not ok or clipboard_error == false then
      notify("Could not export Nvimotator feedback to the clipboard.", vim.log.levels.ERROR)
      return
    end
    notify(string.format("Exported %d annotation%s to the clipboard.", #submission.annotations,
      #submission.annotations == 1 and "" or "s"))
  end)
end

local function finish_submission(submission_id)
  local submission = { id = submission_id, annotations = {} }
  state.phase = "submitting"
  bridge_request("finish", submission, "finished", function(response, finish_error)
    if not response then
      state.phase = "ready"
      state.scheduled_submission = submission_id
      notify("Feedback was scheduled, but bridge cleanup failed: " .. protocol.error_message(finish_error), vim.log.levels.WARN)
      return
    end
    state.phase = "detached"
    state.scheduled_submission = nil
    state.manifest = nil
    draft.delete(identity())
    notify("Feedback scheduled in Pi; the Nvimotator bridge is closed.")
  end)
end

function M.send()
  if state.phase == "ready" and state.store and state.store:count() == 0 and state.scheduled_submission then
    finish_submission(state.scheduled_submission)
    return
  end
  local submission = frozen_submission()
  if not submission then return end
  state.phase = "submitting"
  bridge_request("submit", submission, "submitted", function(response, request_error)
    state.phase = "ready"
    if not response then
      save_draft()
      local suffix = protocol.is_retryable(request_error)
        and " Retry :NvimotatorSend to reuse the same submission ID." or " Edit the annotations before trying again."
      notify(protocol.error_message(request_error) .. suffix, vim.log.levels.ERROR)
      return
    end
    if response.submissionId ~= submission.id or response.annotationCount ~= #submission.annotations or response.status ~= "scheduled" then
      notify("Submit acknowledgement does not match the frozen annotation set.", vim.log.levels.ERROR)
      return
    end
    state.pending = nil
    state.scheduled_submission = submission.id
    state.store:remove_unchanged(submission.annotations)
    if state.store:count() == 0 then
      draft.delete(identity())
      finish_submission(submission.id)
    else
      save_draft()
      notify("Feedback was scheduled; newer or edited annotations remain pending.")
    end
  end)
end

function M.clear()
  if not ensure_ready(false) then return end
  if state.store:count() == 0 and not state.pending then
    notify("There are no pending annotations.")
    return
  end
  local _, modal_error = modal.confirm_clear(state.store:count(), state.pending ~= nil, function()
    if not ensure_ready(false) then return end
    state.pending = nil
    state.store:clear()
    draft.delete(identity())
    notify("Cleared pending Nvimotator annotations.")
  end)
  if modal_error then notify("Could not open clear confirmation: " .. modal_error, vim.log.levels.ERROR) end
end

function M.comments()
  if not ensure_ready(false) then return end
  local _, overview_error = modal.overview(state.store:list(), function(action, record)
    if not ensure_ready(false) then return end
    if action == "clear" then
      M.clear()
    elseif action == "jump" then
      state.store:jump(record.id)
    elseif action == "delete" then
      state.store:delete(record.id)
    elseif action == "edit" then
      local _, modal_error = modal.comment({
        title = "Edit Nvimotator comment",
        initial_text = record.comment,
        source_window = vim.api.nvim_get_current_win(),
        target_line = record.anchor and record.anchor.endLine or nil,
      }, function(value)
        if value == nil then return end
        local edited, edit_error = state.store:edit(record.id, value)
        if not edited then notify(edit_error, vim.log.levels.WARN) end
      end)
      if modal_error then notify("Could not open comment editor: " .. modal_error, vim.log.levels.ERROR) end
    elseif action == "export" then
      M.export()
    elseif action == "send" then
      M.send()
    end
  end)
  if overview_error then notify("Could not open annotation overview: " .. overview_error, vim.log.levels.ERROR) end
end

function M.setup(options)
  config = vim.tbl_deep_extend("force", config, options or {})
end

function M._state()
  return state
end

return M
