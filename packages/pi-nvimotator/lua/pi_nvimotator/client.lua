local uv = vim.uv or vim.loop
local M = {}

local MAX_RESPONSE_BYTES = 4 * 1024 * 1024
local TIMEOUT_MS = 5000

local function close_handle(handle)
  if handle and not handle:is_closing() then
    handle:close()
  end
end

function M.request(manifest, request, callback)
  local tcp = uv.new_tcp()
  local timer = uv.new_timer()
  local chunks = {}
  local bytes = 0
  local completed = false

  local function finish(response, err)
    if completed then return end
    completed = true
    pcall(function() tcp:read_stop() end)
    close_handle(tcp)
    if timer then
      timer:stop()
      close_handle(timer)
    end
    vim.schedule(function()
      callback(response, err)
    end)
  end

  timer:start(TIMEOUT_MS, 0, function()
    finish(nil, "Nvimotator bridge request timed out; delivery status may be uncertain.")
  end)

  tcp:connect(manifest.host, manifest.port, function(connect_error)
    if connect_error then
      finish(nil, "Could not connect to the Nvimotator bridge.")
      return
    end
    tcp:read_start(function(read_error, data)
      if read_error then
        finish(nil, "Could not read the Nvimotator bridge response.")
        return
      end
      if data then
        bytes = bytes + #data
        if bytes > MAX_RESPONSE_BYTES then
          finish(nil, "Nvimotator bridge response exceeded the byte limit.")
          return
        end
        table.insert(chunks, data)
        return
      end

      local frame = table.concat(chunks)
      local newline = frame:find("\n", 1, true)
      if not newline or frame:sub(newline + 1):match("%S") then
        finish(nil, "Nvimotator bridge returned an invalid response frame.")
        return
      end
      local ok, response = pcall(vim.json.decode, frame:sub(1, newline - 1))
      if not ok or type(response) ~= "table" then
        finish(nil, "Nvimotator bridge returned invalid JSON.")
        return
      end
      if response.protocolVersion ~= 1 or response.requestId ~= request.requestId then
        finish(nil, "Nvimotator bridge response identity does not match the request.")
        return
      end
      finish(response)
    end)

    local encoded = vim.json.encode(request) .. "\n"
    tcp:write(encoded, function(write_error)
      if write_error then
        finish(nil, "Could not write the Nvimotator bridge request.")
        return
      end
      tcp:shutdown(function(shutdown_error)
        if shutdown_error then
          finish(nil, "Could not finish the Nvimotator bridge request.")
        end
      end)
    end)
  end)

  return function()
    finish(nil, "Nvimotator request was cancelled.")
  end
end

return M
