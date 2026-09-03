#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES="$PACKAGE_ROOT/tests/fixtures"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-nvimotator-e2e.XXXXXX")
TMUX_SOCKET="$TEST_ROOT/tmux.sock"
SESSION=nvimotator-e2e
ARTIFACTS="$TEST_ROOT/artifacts"
REGISTRY="$TEST_ROOT/registry"
FOREIGN_CWD="$TEST_ROOT/foreign-workspace"
NVIM_SOCKET="$TEST_ROOT/nvim.sock"
EXPORT_PATH="$ARTIFACTS/export.bin"
PI_PANE=""
NVIM_PANE=""
SUCCEEDED=0

mkdir -p "$ARTIFACTS" "$REGISTRY" "$FOREIGN_CWD" "$TEST_ROOT/home" "$TEST_ROOT/state" \
  "$TEST_ROOT/cache" "$TEST_ROOT/config" "$TEST_ROOT/pi-agent" "$TEST_ROOT/sessions"
chmod 700 "$ARTIFACTS" "$REGISTRY" "$FOREIGN_CWD" "$TEST_ROOT/home" "$TEST_ROOT/state" \
  "$TEST_ROOT/cache" "$TEST_ROOT/config" "$TEST_ROOT/pi-agent" "$TEST_ROOT/sessions"

cleanup() {
  local status=$?
  if [[ -n "$PI_PANE" ]]; then
    tmux -S "$TMUX_SOCKET" capture-pane -p -t "$PI_PANE" >"$ARTIFACTS/pi-pane.txt" 2>/dev/null || true
  fi
  if [[ -n "$NVIM_PANE" ]]; then
    tmux -S "$TMUX_SOCKET" capture-pane -p -t "$NVIM_PANE" >"$ARTIFACTS/nvim-pane.txt" 2>/dev/null || true
  fi
  if [[ -d "$REGISTRY" ]]; then
    node - "$REGISTRY" "$ARTIFACTS/registry-redacted.json" <<'NODE' 2>/dev/null || true
const fs = require("fs"); const path = require("path");
const [dir, out] = process.argv.slice(2); const records = [];
for (const name of fs.readdirSync(dir)) if (name.endsWith(".json")) {
  try { const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); value.token = "<redacted>"; records.push({ name, value }); } catch {}
}
fs.writeFileSync(out, JSON.stringify(records, null, 2));
NODE
  fi
  tmux -S "$TMUX_SOCKET" kill-server >/dev/null 2>&1 || true
  if [[ $status -eq 0 && $SUCCEEDED -eq 1 && -z "${PI_NVIMOTATOR_KEEP_E2E:-}" ]]; then
    rm -rf "$TEST_ROOT"
  else
    printf 'pi-nvimotator E2E artifacts preserved at %s\n' "$TEST_ROOT" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

for command in pi nvim tmux node; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 1; }
done
pi --version >"$ARTIFACTS/pi-version.txt"
nvim --version | head -1 >"$ARTIFACTS/nvim-version.txt"
tmux -V >"$ARTIFACTS/tmux-version.txt"
node --version >"$ARTIFACTS/node-version.txt"

cat >"$TEST_ROOT/run-pi.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $(printf '%q' "$PACKAGE_ROOT")
exec env \
  HOME=$(printf '%q' "$TEST_ROOT/home") \
  XDG_STATE_HOME=$(printf '%q' "$TEST_ROOT/state") \
  XDG_CACHE_HOME=$(printf '%q' "$TEST_ROOT/cache") \
  XDG_CONFIG_HOME=$(printf '%q' "$TEST_ROOT/config") \
  PI_CODING_AGENT_DIR=$(printf '%q' "$TEST_ROOT/pi-agent") \
  PI_NVIMOTATOR_REGISTRY=$(printf '%q' "$REGISTRY") \
  NVIMOTATOR_E2E_ARTIFACTS=$(printf '%q' "$ARTIFACTS") \
  NVIMOTATOR_E2E_ASSISTANT=$(printf '%q' "$FIXTURES/assistant.md") \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
  pi --no-extensions \
    -e $(printf '%q' "$PACKAGE_ROOT/index.ts") \
    -e $(printf '%q' "$FIXTURES/fake-provider.ts") \
    --no-skills --no-prompt-templates --no-themes --no-context-files --no-tools \
    --provider nvimotator-e2e --model fixture --api-key e2e-test-key \
    --session-dir $(printf '%q' "$TEST_ROOT/sessions") --approve \
    --system-prompt 'Return only the deterministic provider response.' \
    'Produce the deterministic Nvimotator fixture.'
EOF
chmod 700 "$TEST_ROOT/run-pi.sh"

cat >"$TEST_ROOT/run-nvim.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $(printf '%q' "$FOREIGN_CWD")
exec env \
  HOME=$(printf '%q' "$TEST_ROOT/home") \
  XDG_STATE_HOME=$(printf '%q' "$TEST_ROOT/state") \
  XDG_CACHE_HOME=$(printf '%q' "$TEST_ROOT/cache") \
  XDG_CONFIG_HOME=$(printf '%q' "$TEST_ROOT/config") \
  PI_NVIMOTATOR_PACKAGE=$(printf '%q' "$PACKAGE_ROOT") \
  PI_NVIMOTATOR_REGISTRY=$(printf '%q' "$REGISTRY") \
  NVIMOTATOR_E2E_ARTIFACTS=$(printf '%q' "$ARTIFACTS") \
  NVIMOTATOR_E2E_EXPORT=$(printf '%q' "$EXPORT_PATH") \
  nvim -u $(printf '%q' "$FIXTURES/nvim-init.lua") -i NONE --listen $(printf '%q' "$NVIM_SOCKET")
EOF
chmod 700 "$TEST_ROOT/run-nvim.sh"

wait_file() {
  local path=$1 timeout=${2:-20} start=$SECONDS
  until [[ -e "$path" ]]; do
    (( SECONDS - start < timeout )) || { echo "timed out waiting for $path" >&2; return 1; }
    sleep 0.05
  done
}

wait_pane_text() {
  local pane=$1 text=$2 timeout=${3:-20} start=$SECONDS
  until tmux -S "$TMUX_SOCKET" capture-pane -p -t "$pane" 2>/dev/null | grep -Fq "$text"; do
    (( SECONDS - start < timeout )) || { echo "timed out waiting for pane text: $text" >&2; return 1; }
    sleep 0.1
  done
}

nvim_expr() {
  env HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" XDG_STATE_HOME="$TEST_ROOT/state" \
    nvim --server "$NVIM_SOCKET" --remote-expr "$1"
}

wait_nvim_phase() {
  local expected=$1 timeout=${2:-10} start=$SECONDS value=""
  until value=$(nvim_expr "luaeval('nvimotator_e2e.phase()')" 2>/dev/null) && [[ "$value" == "$expected" ]]; do
    (( SECONDS - start < timeout )) || { echo "timed out waiting for Neovim phase $expected (last: $value)" >&2; return 1; }
    sleep 0.05
  done
}

find_registry_file() {
  find "$REGISTRY" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[1-9][0-9]*\.json' -print | head -1
}

wait_registry_file() {
  local timeout=${1:-10} start=$SECONDS file=""
  until file=$(find_registry_file) && [[ -n "$file" ]]; do
    (( SECONDS - start < timeout )) || return 1
    sleep 0.05
  done
  printf '%s\n' "$file"
}

PI_PANE=$(tmux -S "$TMUX_SOCKET" -f /dev/null new-session -d -P -F '#{pane_id}' -s "$SESSION" -x 180 -y 45 \
  -c "$PACKAGE_ROOT" "$TEST_ROOT/run-pi.sh")
tmux -S "$TMUX_SOCKET" set-option -t "$SESSION" remain-on-exit on
NVIM_PANE=$(tmux -S "$TMUX_SOCKET" split-window -d -h -P -F '#{pane_id}' -t "$PI_PANE" \
  -c "$FOREIGN_CWD" "$TEST_ROOT/run-nvim.sh")

wait_file "$ARTIFACTS/startup.ready"
wait_file "$ARTIFACTS/response-1.ready"
wait_file "$NVIM_SOCKET"
wait_pane_text "$PI_PANE" "NVIMOTATOR_FIXTURE_TAIL_7d91"

tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" -l '/nvim-last'
tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" Enter
if ! MANIFEST_FILE=$(wait_registry_file 2); then
  tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" Enter
  MANIFEST_FILE=$(wait_registry_file 10)
fi
BRIDGE_ID=$(basename "$MANIFEST_FILE" .json)
BRIDGE_SOCKET=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).socketPath' "$MANIFEST_FILE")
wait_pane_text "$PI_PANE" "nvim -c 'NvimotatorAttach $BRIDGE_ID'"

node - "$MANIFEST_FILE" "$ARTIFACTS/tokenless-response.json" <<'NODE'
const fs = require("fs"); const net = require("net");
const [manifestPath, outputPath] = process.argv.slice(2); const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const request = { protocolVersion: 2, requestId: "tokenless-e2e", type: "ping", bridgeId: m.bridgeId,
  instanceId: m.instanceId, sessionId: m.sessionId, snapshotId: m.snapshotId };
const chunks = []; const socket = net.createConnection(m.socketPath);
socket.on("connect", () => socket.end(JSON.stringify(request) + "\n"));
socket.on("data", chunk => chunks.push(chunk));
socket.on("end", () => {
  const response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (response.ok !== false) throw new Error("tokenless request unexpectedly succeeded");
  fs.writeFileSync(outputPath, JSON.stringify({ ok: response.ok, code: response.code }));
});
socket.on("error", error => { throw error; });
NODE

nvim_expr "luaeval('nvimotator_e2e.attach_via_mapping($BRIDGE_ID)')" >/dev/null
wait_nvim_phase ready
nvim_expr "luaeval('nvimotator_e2e.capture()')" >/dev/null
cmp "$FIXTURES/assistant.md" "$ARTIFACTS/attached.bin"
node - "$ARTIFACTS/attached.json" "$FOREIGN_CWD" "$BRIDGE_ID" <<'NODE'
const fs = require("fs"); const [path, cwd, id] = process.argv.slice(2); const value = JSON.parse(fs.readFileSync(path, "utf8"));
if (value.cwd !== cwd || value.bridgeId !== Number(id)) throw new Error("attach changed cwd or bridge identity");
if (value.buftype !== "nofile" || value.filetype !== "markdown" || value.modifiable !== false || value.readonly !== true || value.swapfile !== false) {
  throw new Error("scratch buffer options are not immutable");
}
NODE

[[ $(nvim_expr "luaeval('nvimotator_e2e.annotate_line()')") == 1 ]]
[[ $(nvim_expr "luaeval('nvimotator_e2e.annotate_visual()')") == 2 ]]
[[ $(nvim_expr "luaeval('nvimotator_e2e.global_comment()')") == 3 ]]
nvim_expr "luaeval('nvimotator_e2e.capture_global_panel()')" >/dev/null
wait_file "$ARTIFACTS/global-panel.txt"
grep -Fq 'Global feedback (1)' "$ARTIFACTS/global-panel.txt"
grep -Fq 'Overall feedback.' "$ARTIFACTS/global-panel.txt"
grep -Fq '\ng add · \nc manage' "$ARTIFACTS/global-panel.txt"
[[ $(nvim_expr "luaeval('nvimotator_e2e.quick_line()')") == 4 ]]
wait_file "$ARTIFACTS/modal-geometry.json"
node - "$ARTIFACTS/modal-geometry.json" <<'NODE'
const fs = require("fs"); const value = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (value.kind !== "float" || value.overlap !== 0 || value.occupiedRows !== value.floatHeight + 2) {
  throw new Error("Nvimotator modal did not exclusively occupy displaced rows");
}
NODE
nvim_expr "luaeval('nvimotator_e2e.export()')" >/dev/null
wait_file "$EXPORT_PATH"
grep -Fq 'last assistant message' "$EXPORT_PATH"
grep -Fq 'Incorporate the comments and quick actions' "$EXPORT_PATH"
grep -Fq '# Message Feedback' "$EXPORT_PATH"
grep -Fq '> Tighten this line.' "$EXPORT_PATH"
grep -Fq '> Explain the emoji context.' "$EXPORT_PATH"
grep -Fq '> Overall feedback.' "$EXPORT_PATH"
grep -Fq '> Second global line.' "$EXPORT_PATH"
grep -Fq '🗺️ Missing overview' "$EXPORT_PATH"
grep -Fq '> Provide a narrative overview of what is being built, why it is being built, and how it will be built. Add this before the implementation details.' "$EXPORT_PATH"
grep -Fxq '🙂' "$EXPORT_PATH"

nvim_expr "luaeval('nvimotator_e2e.send()')" >/dev/null
wait_file "$ARTIFACTS/request-2.bin"
cmp "$EXPORT_PATH" "$ARTIFACTS/request-2.bin"
wait_file "$ARTIFACTS/response-2.ready"
wait_pane_text "$PI_PANE" 'NVIMOTATOR_E2E_ACK'
[[ $(cat "$ARTIFACTS/call-count") == 2 ]]
for _ in $(seq 1 100); do [[ ! -e "$MANIFEST_FILE" ]] && break; sleep 0.05; done
[[ ! -e "$MANIFEST_FILE" ]]
[[ ! -e "$BRIDGE_SOCKET" ]]
wait_nvim_phase detached

# File annotation sibling of /nvim-last: snapshot local markdown, same attach/comment/send UX.
ANNOTATE_FILE="$FIXTURES/annotate.md"
tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" -l "/nvim-annotate $ANNOTATE_FILE"
tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" Enter
if ! FILE_MANIFEST=$(wait_registry_file 2); then
  tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" Enter
  FILE_MANIFEST=$(wait_registry_file 10)
fi
FILE_BRIDGE_ID=$(basename "$FILE_MANIFEST" .json)
FILE_SOCKET=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).socketPath' "$FILE_MANIFEST")
wait_pane_text "$PI_PANE" "nvim -c 'NvimotatorAttach $FILE_BRIDGE_ID'"
wait_pane_text "$PI_PANE" "File: $ANNOTATE_FILE"

nvim_expr "luaeval('nvimotator_e2e.attach_via_mapping($FILE_BRIDGE_ID)')" >/dev/null
wait_nvim_phase ready
nvim_expr "luaeval('nvimotator_e2e.capture()')" >/dev/null
cmp "$ANNOTATE_FILE" "$ARTIFACTS/attached.bin"
node - "$ARTIFACTS/attached.json" "$ANNOTATE_FILE" <<'NODE'
const fs = require("fs"); const [path, filePath] = process.argv.slice(2); const value = JSON.parse(fs.readFileSync(path, "utf8"));
if (value.kind !== "file") throw new Error("file snapshot kind is not file");
if (value.filePath !== filePath) throw new Error("file snapshot path does not match");
if (value.buftype !== "nofile" || value.modifiable !== false || value.readonly !== true) {
  throw new Error("file scratch buffer options are not immutable");
}
NODE
[[ $(nvim_expr "luaeval('nvimotator_e2e.annotate_line()')") == 1 ]]
nvim_expr "luaeval('nvimotator_e2e.export()')" >/dev/null
wait_file "$EXPORT_PATH"
grep -Fq 'the local file' "$EXPORT_PATH"
grep -Fq "$ANNOTATE_FILE" "$EXPORT_PATH"
grep -Fq '> Tighten this line.' "$EXPORT_PATH"
grep -Fq '# File Feedback' "$EXPORT_PATH"
if grep -Fq 'the last assistant message' "$EXPORT_PATH"; then echo "file export used last-message wrapper" >&2; exit 1; fi
if grep -Fq 'Assistant entry:' "$EXPORT_PATH"; then echo "file export marked as last-message" >&2; exit 1; fi
nvim_expr "luaeval('nvimotator_e2e.send()')" >/dev/null
wait_file "$ARTIFACTS/request-3.bin"
cmp "$EXPORT_PATH" "$ARTIFACTS/request-3.bin"
wait_file "$ARTIFACTS/response-3.ready"
wait_pane_text "$PI_PANE" 'NVIMOTATOR_E2E_ACK'
[[ $(cat "$ARTIFACTS/call-count") == 3 ]]
for _ in $(seq 1 100); do [[ ! -e "$FILE_MANIFEST" ]] && break; sleep 0.05; done
[[ ! -e "$FILE_MANIFEST" ]]
[[ ! -e "$FILE_SOCKET" ]]
wait_nvim_phase detached

# A hard-killed Pi cannot perform lifecycle cleanup; Neovim must remove only the unchanged stale locator.
tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" -l '/nvim-last'
tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" Enter
if ! STALE_MANIFEST=$(wait_registry_file 2); then
  tmux -S "$TMUX_SOCKET" send-keys -t "$PI_PANE" Enter
  STALE_MANIFEST=$(wait_registry_file 10)
fi
STALE_ID=$(basename "$STALE_MANIFEST" .json)
STALE_SOCKET=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).socketPath' "$STALE_MANIFEST")
PI_PID=$(tmux -S "$TMUX_SOCKET" display-message -p -t "$PI_PANE" '#{pane_pid}')
kill -KILL "$PI_PID"
for _ in $(seq 1 100); do
  [[ $(tmux -S "$TMUX_SOCKET" display-message -p -t "$PI_PANE" '#{pane_dead}') == 1 ]] && break
  sleep 0.05
done
nvim_expr "luaeval('nvimotator_e2e.attach_via_mapping($STALE_ID)')" >/dev/null
for _ in $(seq 1 100); do [[ ! -e "$STALE_MANIFEST" ]] && break; sleep 0.05; done
[[ ! -e "$STALE_MANIFEST" ]]
[[ ! -e "$STALE_SOCKET" ]]
wait_nvim_phase detached

SUCCEEDED=1
echo "pi-nvimotator tmux E2E passed"
