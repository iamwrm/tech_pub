local uv = vim.uv or vim.loop
local M = {}

local MAX_MANIFEST_BYTES = 16 * 1024

local function registry_directory()
  local override = vim.env.PI_NVIMOTATOR_REGISTRY
  if override and override ~= "" then
    return vim.fs.normalize(override)
  end
  local agent = vim.env.PI_CODING_AGENT_DIR
  if agent and agent ~= "" then
    return vim.fs.joinpath(agent, "pi-nvimotator", "registry")
  end
  local home = vim.env.HOME or vim.env.USERPROFILE
  return vim.fs.joinpath(assert(home, "HOME is not set"), ".pi", "agent", "pi-nvimotator", "registry")
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

local function read_file(path)
  local stat = uv.fs_lstat(path)
  local safe, safety_error = private_owner(stat, "Nvimotator manifest")
  if not safe then return nil, safety_error end
  if stat.type ~= "file" then return nil, "Nvimotator manifest is not a regular file." end
  if stat.size > MAX_MANIFEST_BYTES then return nil, "Nvimotator manifest is too large." end
  local fd, open_error = uv.fs_open(path, "r", 384)
  if not fd then return nil, "Could not open Nvimotator manifest: " .. tostring(open_error) end
  local contents, read_error = uv.fs_read(fd, stat.size, 0)
  uv.fs_close(fd)
  if not contents then return nil, "Could not read Nvimotator manifest: " .. tostring(read_error) end
  return contents
end

local function live_pid(pid)
  if type(pid) ~= "number" or pid < 1 or pid % 1 ~= 0 then return false end
  local ok = uv.kill(pid, 0)
  return ok ~= nil and ok ~= false
end

local function remove_if_unchanged(path, expected)
  local current = read_file(path)
  if current == expected then
    pcall(uv.fs_unlink, path)
  end
end

local function valid_identifier(value)
  return type(value) == "string" and #value > 0 and #value <= 256 and not value:find("[%c]")
end

function M.lookup(raw_id)
  local text = tostring(raw_id or "")
  if not text:match("^[1-9]%d*$") then
    return nil, "Bridge ID must be a canonical positive decimal integer."
  end
  local bridge_id = tonumber(text)
  if not bridge_id or bridge_id > 999999 then
    return nil, "Bridge ID must be between 1 and 999999."
  end

  local directory = registry_directory()
  local dir_stat = uv.fs_lstat(directory)
  local safe, safety_error = private_owner(dir_stat, "Nvimotator registry")
  if not safe then return nil, safety_error end
  if dir_stat.type ~= "directory" then return nil, "Nvimotator registry is not a directory." end

  local path = vim.fs.joinpath(directory, text .. ".json")
  local contents, read_error = read_file(path)
  if not contents then return nil, read_error end
  local ok, manifest = pcall(vim.json.decode, contents)
  if not ok or type(manifest) ~= "table" then return nil, "Nvimotator manifest is not valid JSON." end
  if manifest.protocolVersion ~= 1 or manifest.bridgeId ~= bridge_id then
    return nil, "Nvimotator manifest identity or protocol does not match."
  end
  if manifest.host ~= "127.0.0.1" then return nil, "Nvimotator bridge is not bound to IPv4 loopback." end
  if type(manifest.port) ~= "number" or manifest.port < 1 or manifest.port > 65535 or manifest.port % 1 ~= 0 then
    return nil, "Nvimotator manifest has an invalid port."
  end
  if not valid_identifier(manifest.token) or not valid_identifier(manifest.instanceId)
      or not valid_identifier(manifest.sessionId) or not valid_identifier(manifest.snapshotId) then
    return nil, "Nvimotator manifest has invalid identity fields."
  end
  if not live_pid(manifest.pid) then
    remove_if_unchanged(path, contents)
    return nil, "Nvimotator bridge process is not running; its stale locator was removed."
  end
  manifest._path = path
  manifest._raw = contents
  return manifest
end

M.directory = registry_directory
M.remove_if_unchanged = remove_if_unchanged
return M
