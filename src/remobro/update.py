"""Self-update: check GitHub releases, replace the CLI, refresh the Chromium extension files.

Three kinds of installs:
- release binary (PyInstaller, sys.frozen): download the new binary and swap it in place
- `uv tool` install: reinstall from the release tag with uv
- source checkout (.venv of a clone): tell the user to git pull

The Zen/Firefox extension updates itself (signed, update_url). The Chromium extension is
loaded unpacked from EXT_DIR: we replace its files and the bridge asks Chrome to reload it.
"""

from __future__ import annotations

import io
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from importlib import metadata
from pathlib import Path

REPO = "iput-object/remobro"
CHROMIUM_EXT_DIR = Path.home() / "Downloads/remobro/chromium"  # where install.sh unpacks it
SERVICE = Path.home() / ".config/systemd/user/remobro.service"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "remobro"
AUTO_FLAG = CONFIG_DIR / "auto-update"


def current_version() -> str:
    try:
        return metadata.version("remobro")
    except metadata.PackageNotFoundError:
        return "0.0.0"


def parse(v: str) -> tuple[int, ...]:
    parts = []
    for p in v.lstrip("v").split("."):
        digits = "".join(c for c in p if c.isdigit())
        parts.append(int(digits or 0))
    return tuple(parts)


def newer(a: str, b: str) -> bool:
    """a is newer than b"""
    return parse(a) > parse(b)


def _get(url: str, timeout: float = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "remobro-updater", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def latest_version() -> str:
    """Latest release version without the leading v (raises on network errors)."""
    data = json.loads(_get(f"https://api.github.com/repos/{REPO}/releases/latest", 15))
    return str(data["tag_name"]).lstrip("v")


def asset_url(version: str, name: str) -> str:
    return f"https://github.com/{REPO}/releases/download/v{version}/{name}"


def install_kind() -> str:
    if getattr(sys, "frozen", False):
        return "binary"
    if f"{os.sep}uv{os.sep}tools{os.sep}" in sys.prefix:
        return "uv"
    return "source"


def _update_binary(version: str) -> None:
    arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(platform.machine().lower())
    if not arch:
        raise RuntimeError(f"no release binary for {platform.machine()}")
    exe = Path(sys.executable)
    data = _get(asset_url(version, f"remobro-linux-{arch}"), 300)
    fd, tmp = tempfile.mkstemp(dir=exe.parent, prefix=".remobro-new-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o755)
    if subprocess.run([tmp, "--help"], capture_output=True).returncode != 0:
        os.unlink(tmp)
        raise RuntimeError("the downloaded binary does not run on this system")
    os.replace(tmp, exe)  # atomic; the running process keeps its old file


def _update_uv(version: str) -> None:
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv not found")
    subprocess.run([uv, "tool", "install", "--force", "--python", "3.12", f"git+https://github.com/{REPO}@v{version}"],
                   check=True, capture_output=True)


def update_chromium_extension(version: str) -> bool:
    """Replace the unpacked Chromium extension files, if it was installed. True if updated."""
    if not (CHROMIUM_EXT_DIR / "manifest.json").exists():
        return False
    data = _get(asset_url(version, "remobro-chromium.zip"), 120)
    new = CHROMIUM_EXT_DIR.with_name("chromium.new")
    old = CHROMIUM_EXT_DIR.with_name("chromium.old")
    shutil.rmtree(new, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)
    zipfile.ZipFile(io.BytesIO(data)).extractall(new)
    CHROMIUM_EXT_DIR.rename(old)
    new.rename(CHROMIUM_EXT_DIR)
    shutil.rmtree(old, ignore_errors=True)
    return True


def restart_service() -> None:
    if SERVICE.exists():
        subprocess.run(["systemctl", "--user", "restart", "remobro.service"], capture_output=True)


def run(check_only: bool = False, quiet: bool = False) -> int:
    say = (lambda *_: None) if quiet else print
    cur = current_version()
    try:
        latest = latest_version()
    except Exception as e:  # noqa: BLE001 - offline, rate limited, …
        print(f"could not check for updates: {e}", file=sys.stderr)
        return 1
    if not newer(latest, cur):
        say(f"remobro {cur} is up to date")
        return 0
    if check_only:
        say(f"remobro {latest} is available (you have {cur}): run `remobro update`")
        return 0
    kind = install_kind()
    say(f"updating remobro {cur} → {latest} ({kind} install)")
    if kind == "binary":
        _update_binary(latest)
    elif kind == "uv":
        _update_uv(latest)
    else:
        print("this is a source checkout: run `git pull && uv sync` instead", file=sys.stderr)
        return 1
    if update_chromium_extension(latest):
        say(f"updated the Chrome/Chromium extension files in {CHROMIUM_EXT_DIR} (it reloads itself)")
    say("Zen/Firefox update their extension on their own")
    restart_service()  # last: when called from the bridge itself, this ends it
    say(f"done: remobro {latest}")
    return 0


def set_auto(on: bool) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if on:
        AUTO_FLAG.write_text("on\n")
    else:
        AUTO_FLAG.unlink(missing_ok=True)


def auto_enabled() -> bool:
    return AUTO_FLAG.exists()
