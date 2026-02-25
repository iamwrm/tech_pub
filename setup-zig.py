#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""eval "$(uv run setup-zig.py [latest|master|0.14.1])" """

import json, os, platform, subprocess, sys
from pathlib import Path
from urllib.request import urlopen, Request

ZIG = Path(os.environ.get("ZIG_HOME", Path.home() / ".zig"))
MIRRORS = ["https://pkg.machengine.org/zig", "https://zigmirror.hryx.net/zig"]
log = lambda m: print(m, file=sys.stderr)

def fetch(url, t=10):
    return urlopen(Request(url, headers={"User-Agent": "setup-zig"}), timeout=t).read()

def try_mirrors(filename, t=120):
    for m in MIRRORS:
        try: log(f"Trying {m}"); return fetch(f"{m}/{filename}", t)
        except Exception as e: log(f"  {e}")
    raise SystemExit("All mirrors failed")

ver = sys.argv[1] if len(sys.argv) > 1 else "latest"
index = json.loads(try_mirrors("index.json"))
if ver == "latest": ver = next(k for k in index if k != "master")
arch = {"x86_64": "x86_64", "AMD64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[platform.machine()]
plat = {"Linux": "linux", "Darwin": "macos"}[platform.system()]
build = index[ver][f"{arch}-{plat}"]
name = build["tarball"].rsplit("/", 1)[-1].split("?")[0]
ext = ".zip" if name.endswith(".zip") else ".tar.xz"
dest = ZIG / name.removesuffix(ext)

if not (dest / "zig").exists():
    ZIG.mkdir(parents=True, exist_ok=True)
    tmp = ZIG / name
    tmp.write_bytes(try_mirrors(name))
    log(f"Extracting to {dest}")
    subprocess.run(["tar", "-xJf", str(tmp), "-C", str(ZIG)], check=True)
    tmp.unlink()

cur = ZIG / "current"
cur.unlink(missing_ok=True)
cur.symlink_to(dest)
print(f'export PATH="{cur}:$PATH"')
log(f"✓ Zig {subprocess.check_output([str(dest / 'zig'), 'version'], text=True).strip()}")
