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

local function remove_stale(path, expected, socket_path)
  local current = read_file(path)
  if current ~= expected then return end
  if socket_path then
    local socket_stat = uv.fs_lstat(socket_path)
    local safe = socket_stat and private_owner(socket_stat, "Nvimotator socket")
    if safe and socket_stat.type == "socket" then pcall(uv.fs_unlink, socket_path) end
  end
  if read_file(path) == expected then pcall(uv.fs_unlink, path) end
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
  if manifest.bridgeId ~= bridge_id then
    return nil, "Nvimotator manifest identity does not match."
  end
  if not valid_identifier(manifest.token) or not valid_identifier(manifest.instanceId)
      or not valid_identifier(manifest.sessionId) or not valid_identifier(manifest.snapshotId) then
    return nil, "Nvimotator manifest has invalid identity fields."
  end

  local expected_socket = vim.fs.joinpath(directory, text .. ".sock")
  if not live_pid(manifest.pid) then
    local stale_socket = manifest.protocolVersion == 2 and manifest.transport == "unix"
      and manifest.socketPath == expected_socket and expected_socket or nil
    remove_stale(path, contents, stale_socket)
    return nil, "Nvimotator bridge process is not running; its stale locator was removed."
  end

  if manifest.protocolVersion ~= 2 then
    if manifest.protocolVersion == 1 then
      return nil, "Nvimotator bridge uses protocol 1; reload Pi and run /nvim-last again."
    end
    return nil, "Nvimotator bridge protocol is not supported."
  end
  if manifest.transport ~= "unix" or manifest.socketPath ~= expected_socket then
    return nil, "Nvimotator manifest has an invalid Unix socket path."
  end
  local socket_stat = uv.fs_lstat(expected_socket)
  local socket_safe, socket_error = private_owner(socket_stat, "Nvimotator socket")
  if not socket_safe then return nil, socket_error end
  if socket_stat.type ~= "socket" then return nil, "Nvimotator socket path is not a Unix socket." end

  manifest._path = path
  manifest._raw = contents
  manifest._socket_path = expected_socket
  return manifest
end

M.directory = registry_directory
return M
