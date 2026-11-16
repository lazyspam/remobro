#!/usr/bin/env python3
"""Load (or reload) the unsigned Zen Pilot extension into a running Zen as a temporary add-on.

Zen must be running with remote control on (scripts/start-zen-remote.sh). Temporary add-ons
are removed when Zen restarts; for a permanent install, sign the extension (web-ext sign
--channel unlisted) and install the signed .xpi.

usage: zen-pilot pack && python3 scripts/dev-load-extension.py [~/Downloads/zen-pilot/zen-pilot.xpi]
"""

import json
import os
import socket
import sys


def _read(s: socket.socket):
    n = b""
    while not n.endswith(b":"):
        n += s.recv(1)
    size, data = int(n[:-1]), b""
    while len(data) < size:
        data += s.recv(size - len(data))
    return json.loads(data)


def _cmd(s: socket.socket, i: int, name: str, params: dict):
    p = json.dumps([0, i, name, params]).encode()
    s.sendall(str(len(p)).encode() + b":" + p)
    return _read(s)


def main() -> None:
    path = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/Downloads/zen-pilot/zen-pilot.xpi")
    port = int(os.environ.get("MARIONETTE_PORT", "2828"))
    s = socket.create_connection(("127.0.0.1", port))
    _read(s)  # hello
    _cmd(s, 1, "WebDriver:NewSession", {"capabilities": {}})
    res = _cmd(s, 2, "Addon:Install", {"path": path, "temporary": True})
    _cmd(s, 3, "WebDriver:DeleteSession", {})
    if res[2]:
        sys.exit(f"install failed: {res[2]}")
    print("loaded", res[3]["value"])


if __name__ == "__main__":
    main()
