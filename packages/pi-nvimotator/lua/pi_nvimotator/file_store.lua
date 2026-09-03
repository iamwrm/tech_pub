local uv = vim.uv or vim.loop
local feedback = require("pi_nvimotator.feedback")

local M = {}
local DIRECTORY_MODE = 448 -- 0700
local FILE_MODE = 384 -- 0600

local function store_directory()
  local override = vim.env.NVIMOTATOR_STORE
  if override and override ~= "" then
    return vim.fs.normalize(override)
  end
  local home = vim.env.HOME or vim.env.USERPROFILE
  return vim.fs.joinpath(assert(home, "HOME is not set"), ".nvimotator")
end

local function private_owner(stat, label)
  if not stat then
    return nil, label .. " does not exist."
  end
  if stat.type == "link" then
    return nil, label .. " must not be a symbolic link."
  end
  local passwd = uv.os_get_passwd and uv.os_get_passwd() or nil
  if passwd and passwd.uid and stat.uid and passwd.uid ~= stat.uid then
    return nil, label .. " is not owned by the current user."
  end
  if stat.mode and (stat.mode % 512) % 64 ~= 0 then
    return nil, label .. " is accessible by group or other users."
  end
  return true
end

local function live_pid(pid)
  if type(pid) ~= "number" or pid < 1 or pid % 1 ~= 0 then return false end
  local ok = uv.kill(pid, 0)
  return ok ~= nil and ok ~= false
end

local function read_file(path)
  local stat = uv.fs_lstat(path)
  local safe, safety_error = private_owner(stat, "Nvimotator file")
  if not safe then return nil, safety_error end
  if stat.type ~= "file" then return nil, "Nvimotator path is not a regular file." end
  local fd, open_error = uv.fs_open(path, "r", FILE_MODE)
  if not fd then return nil, "Could not open " .. path .. ": " .. tostring(open_error) end
  local contents, read_error = uv.fs_read(fd, stat.size, 0)
  uv.fs_close(fd)
  if not contents then return nil, "Could not read " .. path .. ": " .. tostring(read_error) end
  return contents
end

local function write_private(path, contents)
  local fd, open_error = uv.fs_open(path, "w", FILE_MODE)
  if not fd then return nil, "Could not write " .. path .. ": " .. tostring(open_error) end
  local ok, write_error = uv.fs_write(fd, contents, 0)
  uv.fs_close(fd)
  if not ok then return nil, "Could not write " .. path .. ": " .. tostring(write_error) end
  uv.fs_chmod(path, FILE_MODE)
  return true
end

local function canonical_id(text)
  if not tostring(text or ""):match("^[1-9]%d*$") then return nil end
  local id = tonumber(text)
  if not id or id < 1 or id > 99 then return nil end
  return id
end

local function slot_dir(id)
  return vim.fs.joinpath(store_directory(), tostring(id))
end

function M.directory()
  return store_directory()
end

function M.looks_like_path(raw)
  local text = tostring(raw or "")
  if text:find("[/\\]") or text:sub(1, 1) == "~" or text:sub(1, 1) == "." then
    return true
  end
  return uv.fs_lstat(text) ~= nil
end

function M.parse_id(raw)
  local text = vim.trim(tostring(raw or ""))
  local direct = canonical_id(text)
  if direct then return direct end
  local normalized = text:gsub("\\", "/")
  local id_text = normalized:match("/(%d%d?)/snapshot%.md$") or normalized:match("/(%d%d?)$")
  return canonical_id(id_text)
end

local function read_json(path)
  local contents, err = read_file(path)
  if not contents then return nil, err end
  local ok, value = pcall(vim.json.decode, contents)
  if not ok or type(value) ~= "table" then return nil, "Nvimotator JSON is invalid: " .. path end
  return value
end

function M.lookup(raw)
  local id = M.parse_id(raw)
  if not id then
    return nil, "File-store ID must be 1–99 or a snapshot.md path."
  end
  local directory = store_directory()
  local dir_stat = uv.fs_lstat(directory)
  local safe, safety_error = private_owner(dir_stat, "Nvimotator file store")
  if not safe then return nil, safety_error end
  if dir_stat.type ~= "directory" then return nil, "Nvimotator file store is not a directory." end

  local slot = slot_dir(id)
  local slot_stat = uv.fs_lstat(slot)
  local slot_safe, slot_error = private_owner(slot_stat, "Nvimotator slot")
  if not slot_safe then return nil, slot_error end
  if slot_stat.type ~= "directory" then return nil, "Nvimotator slot is not a directory." end

  local meta, meta_error = read_json(vim.fs.joinpath(slot, "meta.json"))
  if not meta then return nil, meta_error end
  if meta.id ~= id then return nil, "Nvimotator slot identity does not match." end
  if meta.status ~= "exported" then
    return nil, "Nvimotator slot " .. id .. " is not waiting for Send."
  end
  local stored, stored_error = read_json(vim.fs.joinpath(slot, "snapshot.json"))
  if not stored then return nil, stored_error end
  if type(stored.text) ~= "string" or type(stored.snapshotId) ~= "string" then
    return nil, "Nvimotator snapshot.json is incomplete."
  end
  if type(stored.lines) ~= "table" then
    stored.lines = vim.split(stored.text, "\n", { plain = true })
  end
  stored.instanceId = stored.instanceId or ("file-store-" .. tostring(id))
  return {
    id = id,
    dir = slot,
    meta = meta,
    snapshot = stored,
  }
end

function M.lock_attach(slot)
  local path = vim.fs.joinpath(slot.dir, "attach.lock")
  local existing = uv.fs_lstat(path)
  if existing then
    local contents = read_file(path)
    local pid = contents and tonumber(vim.trim(contents))
    if pid and live_pid(pid) and pid ~= vim.fn.getpid() then
      return nil, "Nvimotator slot " .. slot.id .. " is already attached."
    end
    pcall(uv.fs_unlink, path)
  end
  local fd, err = uv.fs_open(path, "wx", FILE_MODE)
  if not fd then return nil, "Could not lock Nvimotator slot: " .. tostring(err) end
  uv.fs_write(fd, tostring(vim.fn.getpid()) .. "\n", 0)
  uv.fs_close(fd)
  uv.fs_chmod(path, FILE_MODE)
  return true
end

function M.unlock_attach(slot)
  if not slot or not slot.dir then return end
  pcall(uv.fs_unlink, vim.fs.joinpath(slot.dir, "attach.lock"))
end

local function ensure_last_dir()
  local last = vim.fs.joinpath(store_directory(), "last")
  vim.fn.mkdir(last, "p", DIRECTORY_MODE)
  uv.fs_chmod(last, DIRECTORY_MODE)
  return last
end

function M.write_annotation(slot, annotations)
  local prompt, err = feedback.build_wrapped(slot.snapshot, feedback.wire_annotations(annotations))
  if not prompt then return nil, err end
  local annotation_path = vim.fs.joinpath(slot.dir, "annotation.md")
  local annotations_path = vim.fs.joinpath(slot.dir, "annotations.json")
  local ok, write_error = write_private(annotations_path, vim.json.encode(feedback.wire_annotations(annotations)))
  if not ok then return nil, write_error end
  ok, write_error = write_private(annotation_path, prompt:sub(-1) == "\n" and prompt or (prompt .. "\n"))
  if not ok then return nil, write_error end
  local last_dir = ensure_last_dir()
  local last_path = vim.fs.joinpath(last_dir, "annotation.md")
  ok, write_error = write_private(last_path, prompt:sub(-1) == "\n" and prompt or (prompt .. "\n"))
  if not ok then return nil, write_error end
  local meta = vim.deepcopy(slot.meta)
  meta.status = "sent"
  meta.sentAt = os.date("!%Y-%m-%dT%H:%M:%S.000Z")
  ok, write_error = write_private(vim.fs.joinpath(slot.dir, "meta.json"), vim.json.encode(meta))
  if not ok then return nil, write_error end
  slot.meta = meta
  return {
    annotation_path = annotation_path,
    last_path = last_path,
    prompt = prompt,
  }
end

function M.mark_cancelled(slot)
  if not slot then return end
  local meta = vim.deepcopy(slot.meta or {})
  meta.status = "cancelled"
  pcall(write_private, vim.fs.joinpath(slot.dir, "meta.json"), vim.json.encode(meta))
  M.unlock_attach(slot)
end

return M
