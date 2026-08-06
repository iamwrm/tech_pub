#!/usr/bin/env bash
set -euo pipefail

REPO="PrimeIntellect-ai/prime-agent"

usage() {
  cat <<'EOF'
Usage: install_update_pa.sh [tag]

Download, verify, and globally install a Prime Agent GitHub Release.
When tag is omitted, the latest production release is used.

Examples:
  ./install_update_pa.sh
  ./install_update_pa.sh v0.7.0
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

for command in gh node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "error: required command not found: $command" >&2
    exit 1
  fi
done

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 8) ? 0 : 1)'; then
  echo "error: Prime Agent requires Node.js 22.8.0 or newer; found $(node --version)" >&2
  exit 1
fi

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
fi

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: expected a production release tag like v0.7.0, got: $TAG" >&2
  exit 1
fi

VERSION="${TAG#v}"
TARBALL="prime-agent-$VERSION.tgz"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-$VERSION-update.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

cd "$WORK_DIR"

echo "Downloading Prime Agent $TAG from GitHub Releases..."
gh release download "$TAG" \
  --repo "$REPO" \
  --pattern "$TARBALL" \
  --pattern "SHA256SUMS"

if ! grep " $TARBALL\$" SHA256SUMS > SHA256SUMS.prime-agent; then
  echo "error: checksum for $TARBALL was not found in SHA256SUMS" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS.prime-agent
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c SHA256SUMS.prime-agent
else
  echo "error: sha256sum or shasum is required to verify the release" >&2
  exit 1
fi

if command -v prime-agent >/dev/null 2>&1; then
  echo "Stopping running Prime Agent services before updating..."
  prime-agent shutdown
fi

echo "Installing Prime Agent $TAG globally with npm..."
npm install -g --no-fund --no-audit "./$TARBALL"

echo "Installed Prime Agent $TAG."
prime-agent --version
