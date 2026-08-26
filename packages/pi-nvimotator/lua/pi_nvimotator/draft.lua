local uv = vim.uv or vim.loop
local M = {}

local MAX_DRAFT_BYTES = 1024 * 1024
local DIRECTORY_MODE = 448 -- 0700
local FILE_MODE = 384 -- 0600


local QUICK_ACTION_IDS = {
  deletion = true,
  ["thumbs-up"] = true,
  ["clarify-this"] = true,
  ["missing-overview"] = true,
  ["verify-this"] = true,
  ["give-me-an-example"] = true,
  ["match-existing-patterns"] = true,
  ["consider-alternatives"] = true,
  ["ensure-no-regression"] = true,
  ["out-of-scope"] = true,
  ["needs-tests"] = true,
  ["nice-approach"] = true,
}
local function directory()
  return vim.fs.joinpath(vim.fn.stdpath("state"), "pi-nvimotator", "drafts")
end

local function path_for(identity)
  local key = vim.fn.sha256(vim.json.encode({ identity.instanceId, identity.snapshotId }))
  return vim.fs.joinpath(directory(), key .. ".json")
end

local function private_stat(stat)
  if not stat or stat.type ~= "file" or stat.type == "link" then return false end
  local passwd = uv.os_get_passwd and uv.os_get_passwd() or nil
  if passwd and passwd.uid and stat.uid and passwd.uid ~= stat.uid then return false end
  return not stat.mode or (stat.mode % 512) % 64 == 0
end

local function clean_anchor(anchor)
  if type(anchor) ~= "table" then return nil end
  if anchor.selection ~= "line" and anchor.selection ~= "character" then return nil end
  for _, key in ipairs({ "startLine", "startByte", "endLine", "endByte" }) do
    if type(anchor[key]) ~= "number" or anchor[key] < (key:find("Line") and 1 or 0) or anchor[key] % 1 ~= 0 then
      return nil
    end
  end
  return {
    selection = anchor.selection,
    startLine = anchor.startLine,
    startByte = anchor.startByte,
    endLine = anchor.endLine,
    endByte = anchor.endByte,
  }
end

local function clean_records(records)
  if type(records) ~= "table" or #records > 200 then return nil end
  local result, seen = {}, {}
  for _, record in ipairs(records) do
    if type(record) ~= "table" or type(record.id) ~= "string" or seen[record.id] then return nil end
    seen[record.id] = true
    local clean = { id = record.id, kind = record.kind }
    if record.anchor ~= nil then
      clean.anchor = clean_anchor(record.anchor)
      if not clean.anchor then return nil end
    end
    if record.kind == "comment" and type(record.comment) == "string" and #record.comment <= 16 * 1024 then
      clean.comment = record.comment
    elseif record.kind == "quickAction" and clean.anchor and QUICK_ACTION_IDS[record.actionId] then
      clean.actionId = record.actionId
      if type(record.actionLabel) == "string" then clean.actionLabel = record.actionLabel end
    else
      return nil
    end
    table.insert(result, clean)
  end
  return result
end

local function payload(identity, records, pending)
  local clean_records_value = clean_records(records)
  if not clean_records_value then return nil, "Nvimotator annotations exceed protocol limits." end
  local clean_pending
  if pending then
    local pending_records = clean_records(pending.annotations)
    if type(pending.id) ~= "string" or type(pending.fingerprint) ~= "string" or not pending_records then
      return nil, "Nvimotator pending submission exceeds protocol limits."
    end
    clean_pending = {
      id = pending.id,
      fingerprint = pending.fingerprint,
      annotations = pending_records,
    }
  end
  return {
    schemaVersion = 1,
    instanceId = identity.instanceId,
    sessionId = identity.sessionId,
    snapshotId = identity.snapshotId,
    entryId = identity.entryId,
    messageHash = identity.messageHash,
    annotations = clean_records_value,
    pendingSubmission = clean_pending,
  }
end

local function ensure_directory()
  vim.fn.mkdir(directory(), "p", DIRECTORY_MODE)
  pcall(uv.fs_chmod, vim.fs.dirname(directory()), DIRECTORY_MODE)
  pcall(uv.fs_chmod, directory(), DIRECTORY_MODE)
end

function M.save(identity, records, pending)
  ensure_directory()
  local value, payload_error = payload(identity, records, pending)
  if not value then return nil, payload_error end
  local encoded = vim.json.encode(value) .. "\n"
  if #encoded > MAX_DRAFT_BYTES then return nil, "Nvimotator draft is too large." end
  local target = path_for(identity)
  local temporary = target .. string.format(".%d.%d.tmp", vim.fn.getpid(), math.random(1, 1000000000))
  local fd, open_error = uv.fs_open(temporary, "wx", FILE_MODE)
  if not fd then return nil, "Could not create Nvimotator draft: " .. tostring(open_error) end
  local ok, write_error = uv.fs_write(fd, encoded, 0)
  if ok then uv.fs_fsync(fd) end
  uv.fs_close(fd)
  if not ok then
    pcall(uv.fs_unlink, temporary)
    return nil, "Could not write Nvimotator draft: " .. tostring(write_error)
  end
  pcall(uv.fs_chmod, temporary, FILE_MODE)
  local renamed, rename_error = uv.fs_rename(temporary, target)
  if not renamed then
    pcall(uv.fs_unlink, temporary)
    return nil, "Could not publish Nvimotator draft: " .. tostring(rename_error)
  end
  pcall(uv.fs_chmod, target, FILE_MODE)
  return true
end

function M.load(identity)
  local target = path_for(identity)
  local stat = uv.fs_lstat(target)
  if not stat then return { annotations = {} } end
  if not private_stat(stat) then return nil, "Nvimotator draft is not a private regular file; it was preserved." end
  if stat.size > MAX_DRAFT_BYTES then return nil, "Nvimotator draft is oversized; it was preserved." end
  local fd, open_error = uv.fs_open(target, "r", FILE_MODE)
  if not fd then return nil, "Could not open Nvimotator draft: " .. tostring(open_error) end
  local contents = uv.fs_read(fd, stat.size, 0)
  uv.fs_close(fd)
  local ok, decoded = pcall(vim.json.decode, contents or "")
  if not ok or type(decoded) ~= "table" then return nil, "Nvimotator draft is corrupt; it was preserved." end
  if decoded.schemaVersion ~= 1 or decoded.instanceId ~= identity.instanceId or decoded.sessionId ~= identity.sessionId
      or decoded.snapshotId ~= identity.snapshotId or decoded.entryId ~= identity.entryId or decoded.messageHash ~= identity.messageHash then
    return nil, "Nvimotator draft belongs to a different snapshot; it was preserved."
  end
  local records = clean_records(decoded.annotations)
  if not records then return nil, "Nvimotator draft annotations are invalid; the draft was preserved." end
  local pending
  if decoded.pendingSubmission ~= nil then
    local value = decoded.pendingSubmission
    if type(value) ~= "table" or type(value.id) ~= "string" or type(value.fingerprint) ~= "string" then
      return nil, "Nvimotator pending submission is invalid; the draft was preserved."
    end
    local annotations = clean_records(value.annotations)
    if not annotations then return nil, "Nvimotator pending annotations are invalid; the draft was preserved." end
    pending = { id = value.id, fingerprint = value.fingerprint, annotations = annotations }
  end
  return { annotations = records, pendingSubmission = pending }
end

function M.delete(identity)
  local ok, err = uv.fs_unlink(path_for(identity))
  if not ok and err and not tostring(err):match("ENOENT") then return nil, tostring(err) end
  return true
end

M.path_for = path_for
return M
