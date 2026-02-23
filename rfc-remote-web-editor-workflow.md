# RFC: Remote Web Editor Workflow in cmux Browser (OpenVSCode Server)

Status: Draft  
Last updated: February 22, 2026

## Summary

This RFC defines a practical workflow for inspecting and editing remote files inside cmux by:

1. Running `openvscode-server` on the remote host (bound to loopback only).
2. Forwarding it through an SSH local tunnel.
3. Opening the tunneled URL in cmux's built-in browser panel.

This gives a full file explorer + code editor without adding native file UI to cmux.

## Motivation

cmux users need a fast way to:

1. Inspect files modified by coding agents.
2. Edit files directly when reviewing/fixing agent changes.
3. Do this on both local and remote hosts.

A web editor inside the existing cmux browser is the shortest path to value.

## Goals

1. Support remote file browse/edit in cmux today.
2. Keep deployment simple for user-level SSH access.
3. Keep security sane by default (loopback bind + token + SSH tunnel).
4. Define a workflow that can later be wrapped by native `cmux files ...` commands.

## Non-Goals

1. Building a native AppKit file explorer/editor in this RFC.
2. Replacing terminal-based editors for all workflows.
3. Exposing remote editor ports publicly on the internet.

## Proposed Workflow

### 1) One-time install on remote host

```bash
ssh user@remote 'bash -s' << 'EOF'
  set -euo pipefail
  VERSION="1.96.4"
  ARCH="x64"
  mkdir -p ~/.local ~/.local/bin
  curl -fsSL "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${VERSION}/openvscode-server-v${VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz -C ~/.local/
  ln -sf ~/.local/openvscode-server-v${VERSION}-linux-${ARCH}/bin/openvscode-server ~/.local/bin/ovscode
EOF
```

### 2) Start remote server (loopback only)

```bash
TOKEN=$(openssl rand -hex 16)
ssh user@remote "~/.local/bin/ovscode \
  --host 127.0.0.1 \
  --port 3000 \
  --connection-token ${TOKEN} \
  --default-folder ~/project"
```

### 3) Tunnel to local machine

```bash
ssh -N -L 3000:127.0.0.1:3000 user@remote
```

### 4) Open in cmux browser

```bash
cmux browser open "http://127.0.0.1:3000/?tkn=${TOKEN}"
```

## Poor GitHub Connectivity Fallback

If remote host cannot download from GitHub reliably:

1. Download tarball locally.
2. `scp` tarball to remote.
3. Extract remotely and create `~/.local/bin/ovscode` symlink.

This avoids remote network dependency on GitHub/CDN quality.

## Security Model

Required defaults:

1. Bind editor to `127.0.0.1` on remote (`--host 127.0.0.1`).
2. Use a per-session random `--connection-token`.
3. Access only through SSH tunnel (`ssh -L ...`).

Recommended operational guardrails:

1. Do **not** bind to `0.0.0.0`.
2. Rotate token per session.
3. Keep tunnels/processes short-lived unless intentionally persistent.

## Operational Notes

1. `--default-folder` should point to intended repo/workspace.
2. If port `3000` is busy, choose a random high port on both remote and local sides.
3. For persistent usage, run server under `systemd --user` (future runbook).

## Troubleshooting

1. `403` at root URL: token missing/wrong -> use `?tkn=<token>`.
2. SSH tunnel fails: local port already in use -> change local forward port.
3. Blank page or disconnect: tunnel dropped -> restart SSH tunnel.
4. Wrong folder opens: `--default-folder` path invalid -> set explicit existing path.

## Future Native cmux Integration

This workflow can be wrapped in first-class commands:

1. `cmux files open --ssh user@host --path /repo --tool openvscode`
2. `cmux files list`
3. `cmux files close [--id ...]`

Expected behavior for `files open`:

1. Bootstrap tool if missing (or return actionable install hint).
2. Start remote process with loopback bind + generated token.
3. Start local tunnel.
4. Open cmux browser surface to tunneled URL.
5. Track lifecycle for cleanup.

## Acceptance Criteria

A workflow is considered successful when all pass:

1. Open remote file tree from cmux browser.
2. Open/edit/save a file.
3. Changes persist on remote disk.
4. Session remains private to SSH tunnel access.
