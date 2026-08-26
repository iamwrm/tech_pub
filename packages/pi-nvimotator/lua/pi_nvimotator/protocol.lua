local M = {}
local request_counter = 0

local function identifier(prefix)
  request_counter = request_counter + 1
  return string.format("%s-%d-%d-%d", prefix, vim.fn.getpid(), os.time(), request_counter)
end

function M.request_id()
  return identifier("request")
end

function M.submission_id()
  return identifier("submission")
end

function M.base(manifest, kind)
  return {
    protocolVersion = 2,
    requestId = M.request_id(),
    type = kind,
    token = manifest.token,
    bridgeId = manifest.bridgeId,
    instanceId = manifest.instanceId,
    sessionId = manifest.sessionId,
    snapshotId = manifest.snapshotId,
  }
end

local function issue(message, code, retryable)
  return { message = message, code = code or "client_error", retryable = retryable == true }
end

function M.validate_response(response, manifest, expected_type)
  if type(response) ~= "table" then return nil, issue("Bridge returned no response.") end
  if response.ok ~= true then
    local message = type(response.message) == "string" and response.message or "Nvimotator bridge rejected the request."
    local code = type(response.code) == "string" and response.code or "bridge_error"
    return nil, issue(message, code, response.retryable == true)
  end
  if response.type ~= expected_type then return nil, issue("Bridge response type does not match.") end
  if response.bridgeId ~= manifest.bridgeId or response.instanceId ~= manifest.instanceId
      or response.sessionId ~= manifest.sessionId or response.snapshotId ~= manifest.snapshotId then
    return nil, issue("Bridge response identity does not match the locator.")
  end
  return response
end

function M.error_message(value)
  return type(value) == "table" and tostring(value.message or "Nvimotator request failed.") or tostring(value)
end

function M.is_retryable(value)
  return type(value) ~= "table" or value.retryable == true
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
    table.insert(result, item)
  end
  return result
end

return M
