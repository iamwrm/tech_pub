#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-nvimotator-nvim.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/home" "$TEST_ROOT/state" "$TEST_ROOT/cache" "$TEST_ROOT/config" "$TEST_ROOT/registry"
chmod 700 "$TEST_ROOT" "$TEST_ROOT/home" "$TEST_ROOT/state" "$TEST_ROOT/cache" "$TEST_ROOT/config" "$TEST_ROOT/registry"

HOME="$TEST_ROOT/home" \
XDG_STATE_HOME="$TEST_ROOT/state" \
XDG_CACHE_HOME="$TEST_ROOT/cache" \
XDG_CONFIG_HOME="$TEST_ROOT/config" \
PI_NVIMOTATOR_PACKAGE="$PACKAGE_ROOT" \
PI_NVIMOTATOR_TEST_ROOT="$TEST_ROOT" \
PI_NVIMOTATOR_REGISTRY="$TEST_ROOT/registry" \
nvim --headless -u NONE -i NONE \
  --cmd "set runtimepath^=$PACKAGE_ROOT noshowmode" \
  -c "runtime plugin/pi_nvimotator.lua" \
  -l "$PACKAGE_ROOT/tests/nvim_spec.lua"
