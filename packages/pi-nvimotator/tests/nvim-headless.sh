#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-nvimotator-nvim.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/home" "$TEST_ROOT/state" "$TEST_ROOT/cache" "$TEST_ROOT/config" "$TEST_ROOT/registry" "$TEST_ROOT/store"
chmod 700 "$TEST_ROOT" "$TEST_ROOT/home" "$TEST_ROOT/state" "$TEST_ROOT/cache" "$TEST_ROOT/config" "$TEST_ROOT/registry" "$TEST_ROOT/store"

nvim_major_minor() {
  local version
  version=$("$1" --version 2>/dev/null | head -n 1 || true)
  if [[ "$version" =~ NVIM\ v([0-9]+)\.([0-9]+) ]]; then
    printf '%s.%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  fi
}

nvim_is_new_enough() {
  local mm major minor
  mm=$(nvim_major_minor "$1")
  [[ -n "$mm" ]] || return 1
  major=${mm%%.*}
  minor=${mm#*.}
  if (( major > 0 || minor >= 10 )); then
    return 0
  fi
  return 1
}

resolve_nvim() {
  local candidates=()
  local bin mm
  if [[ -n "${NVIM_BIN:-}" ]]; then
    candidates+=("$NVIM_BIN")
  fi
  if command -v nvim >/dev/null 2>&1; then
    candidates+=("$(command -v nvim)")
  fi
  for bin in \
    /tmp/nvim-dist/nvim-linux-x86_64/bin/nvim \
    /opt/nvim/bin/nvim \
    "$HOME/.local/bin/nvim"; do
    [[ -x "$bin" ]] && candidates+=("$bin")
  done
  for bin in "${candidates[@]}"; do
    if [[ -x "$bin" ]] && nvim_is_new_enough "$bin"; then
      printf '%s\n' "$bin"
      return 0
    fi
  done
  mm=$(nvim_major_minor "$(command -v nvim 2>/dev/null || true)" || true)
  printf 'Neovim 0.10+ is required for pi-nvimotator headless tests (found: %s).\n' \
    "${mm:-none}" >&2
  printf 'Install a current Neovim or set NVIM_BIN to its path.\n' >&2
  exit 1
}

NVIM=$(resolve_nvim)

HOME="$TEST_ROOT/home" \
XDG_STATE_HOME="$TEST_ROOT/state" \
XDG_CACHE_HOME="$TEST_ROOT/cache" \
XDG_CONFIG_HOME="$TEST_ROOT/config" \
PI_NVIMOTATOR_PACKAGE="$PACKAGE_ROOT" \
PI_NVIMOTATOR_TEST_ROOT="$TEST_ROOT" \
PI_NVIMOTATOR_REGISTRY="$TEST_ROOT/registry" \
NVIMOTATOR_STORE="$TEST_ROOT/store" \
"$NVIM" --headless -u NONE -i NONE \
  --cmd "set runtimepath^=$PACKAGE_ROOT noshowmode" \
  -c "runtime plugin/pi_nvimotator.lua" \
  -l "$PACKAGE_ROOT/tests/nvim_spec.lua"
