#!/usr/bin/env bash
# Install nvim-last / nvim-annotate / nvim-import Agent Skills with an absolute nvimotator path.
# Codex Desktop may not inherit PATH, so skills must not rely on it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin/nvimotator"
DEST="${NVIMOTATOR_SKILLS_DIR:-$HOME/.agents/skills}"

usage() {
  cat <<'EOF'
Install Codex nvimotator Agent Skills.

Usage:
  scripts/install-skills.sh
  scripts/install-skills.sh --repo
  NVIMOTATOR_SKILLS_DIR=/tmp/skills scripts/install-skills.sh

  --repo   Install into $PWD/.agents/skills (repo-local Codex skills)
  --help   Show this help

Writes nvim-last, nvim-annotate, and nvim-import under the destination,
substituting the absolute path to this host's bin/nvimotator. Does not
write hooks.json.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      DEST="$PWD/.agents/skills"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -x "$BIN" ]]; then
  chmod +x "$BIN" 2>/dev/null || true
fi
if [[ ! -f "$ROOT/cli.bundle.js" ]]; then
  echo "warning: cli.bundle.js is missing; from $(cd "$ROOT/.." && pwd) run: npm ci && npm run build" >&2
fi

mkdir -p "$DEST"
for name in nvim-last nvim-annotate nvim-import; do
  src="$ROOT/skills/$name/SKILL.md"
  out_dir="$DEST/$name"
  mkdir -p "$out_dir"
  python3 - "$src" "$out_dir/SKILL.md" "$BIN" <<'PY'
from pathlib import Path
import sys
src, dest, binary = sys.argv[1], sys.argv[2], sys.argv[3]
text = Path(src).read_text()
if "__NVIMOTATOR_BIN__" not in text:
    raise SystemExit("skill template is missing __NVIMOTATOR_BIN__")
Path(dest).write_text(text.replace("__NVIMOTATOR_BIN__", binary))
PY
done

printf 'Installed Codex nvimotator skills into %s\n' "$DEST"
printf 'Binary: %s\n' "$BIN"
printf 'Invoke in Codex as $nvim-last, $nvim-annotate, $nvim-import, or !%s export\n' "$BIN"
printf 'Neovim plugin still lives in packages/pi-nvimotator (runtimepath).\n'
printf 'No hooks.json was written (Stop / plan review is out of scope).\n'
