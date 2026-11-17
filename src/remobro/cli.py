"""remobro command line."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

SERVICE = Path.home() / ".config/systemd/user/remobro.service"


def cmd_daemon(_: argparse.Namespace) -> None:
    from .daemon import serve

    serve()


def cmd_url(_: argparse.Namespace) -> None:
    from .daemon import mcp_url

    print(mcp_url())


def _register(client: str, cmd: list[str]) -> bool:
    """Register the MCP server with one client. A broken client config must not abort the install."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    except OSError as e:
        print(f"warning: could not register with {client}: {e}", file=sys.stderr)
        return False
    if r.returncode == 0:
        return True
    err = (r.stderr or r.stdout).strip()
    print(f"warning: could not register with {client} (exit {r.returncode})", file=sys.stderr)
    if err:
        print("  " + err.replace("\n", "\n  "), file=sys.stderr)
    print(f"  fix that, then run: {' '.join(cmd)}", file=sys.stderr)
    return False


def cmd_install(args: argparse.Namespace) -> None:
    """Run the daemon as a systemd user service and register the MCP server with Claude Code and Codex."""
    from .daemon import mcp_url

    # the remobro executable running right now: the release binary, a `uv tool` install, or a checkout's .venv
    exe = Path(sys.executable if getattr(sys, "frozen", False) else sys.argv[0]).absolute()
    SERVICE.parent.mkdir(parents=True, exist_ok=True)
    SERVICE.write_text(
        "[Unit]\nDescription=remobro: MCP bridge to your browser\n\n"
        f"[Service]\nExecStart={exe} daemon\nRestart=on-failure\nRestartSec=2\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "remobro.service"], check=True)
    subprocess.run(["systemctl", "--user", "restart", "remobro.service"], check=True)
    print(f"daemon service: {SERVICE}")

    url = mcp_url()
    if shutil.which("claude") and "claude" in args.clients:
        subprocess.run(["claude", "mcp", "remove", "-s", "user", "remobro"], capture_output=True)
        if _register("Claude Code (user scope)", ["claude", "mcp", "add", "-s", "user", "--transport", "http", "remobro", url]):
            print("registered with Claude Code (user scope) as 'remobro'")
    if shutil.which("codex") and "codex" in args.clients:
        subprocess.run(["codex", "mcp", "remove", "remobro"], capture_output=True)
        if _register("Codex", ["codex", "mcp", "add", "remobro", "--url", url]):
            print("registered with Codex as 'remobro'")
    print("MCP URL (for other clients):", url)


def cmd_update(args: argparse.Namespace) -> None:
    """Update remobro to the latest release (the binary or uv install, the Chromium extension files, the bridge)."""
    from . import update

    if args.auto:
        update.set_auto(args.auto == "on")
        print(f"automatic updates {args.auto}" + (" (the bridge checks once a day)" if args.auto == "on" else ""))
        return
    sys.exit(update.run(check_only=args.check, quiet=args.quiet))


def cmd_uninstall(_: argparse.Namespace) -> None:
    """Stop and remove the systemd service and the MCP registrations (sessions and notes are kept)."""
    if SERVICE.exists():
        subprocess.run(["systemctl", "--user", "disable", "--now", "remobro.service"], capture_output=True)
        SERVICE.unlink()
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        print(f"removed {SERVICE}")
    if shutil.which("claude"):
        subprocess.run(["claude", "mcp", "remove", "-s", "user", "remobro"], capture_output=True)
    if shutil.which("codex"):
        subprocess.run(["codex", "mcp", "remove", "remobro"], capture_output=True)
    print("removed MCP server 'remobro' from Claude Code / Codex")


def cmd_call(args: argparse.Namespace) -> None:
    """Call one remobro tool from the shell (for shell-only agents and scripts). Keeps a session between calls."""
    import asyncio
    import json

    from mcp import ClientSession, types
    from mcp.client.streamable_http import streamablehttp_client

    from .daemon import CONFIG_DIR, mcp_url

    import logging

    logging.disable(logging.INFO)
    sess_file = CONFIG_DIR / f"cli-session-{args.as_}"
    params = json.loads(args.json) if args.json else {}

    async def run() -> int:
        async with streamablehttp_client(mcp_url()) as (r, w, _):
            info = types.Implementation(name=f"{args.as_}-cli", version="1")
            async with ClientSession(r, w, client_info=info) as s:
                await s.initialize()
                op = params.get("op") if args.tool == "session" else None
                sid = sess_file.read_text().strip() if sess_file.exists() else ""
                if sid and op not in ("start", "resume", "list"):
                    await s.call_tool("session", {"op": "resume", "id": sid})
                res = await s.call_tool(args.tool, params)
                for c in res.content:
                    if c.type == "text":
                        print(c.text)
                if op == "start" and not res.isError:
                    sess_file.write_text(res.content[0].text.split()[1])
                elif op == "resume" and not res.isError:
                    sess_file.write_text(params["id"])
                elif op == "end":
                    sess_file.unlink(missing_ok=True)
                return 1 if res.isError else 0

    sys.exit(asyncio.run(run()))


def cmd_replay(args: argparse.Namespace) -> None:
    """Replay a recorded test (session export) without any LLM: zero tokens, deterministic."""
    import asyncio
    import json
    import logging
    import time

    from mcp import ClientSession, types
    from mcp.client.streamable_http import streamablehttp_client

    from .daemon import mcp_url

    logging.disable(logging.INFO)
    test = json.loads(Path(args.file).read_text())
    steps = test["steps"]

    async def run() -> int:
        async with streamablehttp_client(mcp_url()) as (r, w, _):
            async with ClientSession(r, w, client_info=types.Implementation(name="replay", version="1")) as s:
                await s.initialize()
                await s.call_tool("session", {"op": "start", "text": f"replay: {test.get('name', args.file)}"})
                t0, opened, i = time.time(), False, 0
                while i < len(steps):
                    st = steps[i]
                    if st["do"] == "goto" and not opened:
                        res = await s.call_tool("open", {"url": st["url"]})
                        opened, i, label = True, i + 1, f"open {st['url']}"
                    else:
                        chunk = [st]
                        i += 1
                        while i < len(steps) and len(chunk) < 25 and steps[i]["do"] != "goto":
                            chunk.append(steps[i])
                            i += 1
                        res = await s.call_tool("act", {"steps": chunk})
                        label = f"{len(chunk)} step(s)"
                    text = "\n".join(c.text for c in res.content if c.type == "text")
                    failed = res.isError or "\n✗" in "\n" + text
                    print(f"{'FAIL' if failed else 'ok  '} {label}")
                    if failed or args.verbose:
                        print("  " + text.replace("\n", "\n  "))
                    if failed:
                        print(f"FAILED after {time.time() - t0:.1f}s")
                        return 1
                print(f"PASSED {len(steps)} steps in {time.time() - t0:.1f}s")
                return 0

    sys.exit(asyncio.run(run()))


def cmd_run(args: argparse.Namespace) -> None:
    try:
        from .runner import main as runner_main
    except ImportError:
        sys.exit("the runner needs extras: uv sync --extra runner")
    sys.argv = ["remobro run", *args.rest]
    runner_main()


def main() -> None:
    p = argparse.ArgumentParser(prog="remobro", description="Let AI agents drive your browser over MCP.")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("daemon", help="run the bridge (MCP on :8765/mcp, extension socket on :8765/ext)").set_defaults(fn=cmd_daemon)
    sub.add_parser("url", help="print the MCP URL (includes the access key)").set_defaults(fn=cmd_url)
    ins = sub.add_parser("install", help="systemd user service + register with Claude Code / Codex")
    ins.add_argument("--clients", nargs="*", default=["claude", "codex"])
    ins.set_defaults(fn=cmd_install)
    sub.add_parser("uninstall", help="remove the service and MCP registrations").set_defaults(fn=cmd_uninstall)
    up = sub.add_parser("update", help="update to the latest release")
    up.add_argument("--check", action="store_true", help="only report whether an update is available")
    up.add_argument("--auto", choices=["on", "off"], help="let the bridge install updates by itself (daily check)")
    up.add_argument("--quiet", action="store_true")
    up.set_defaults(fn=cmd_update)
    sub.add_parser("version", help="print the installed version").set_defaults(fn=lambda _: print(__import__("remobro.update").update.current_version()))
    cl = sub.add_parser("call", help="call a tool: remobro call act '{\"steps\":[...]}'")
    cl.add_argument("tool")
    cl.add_argument("json", nargs="?", default="")
    cl.add_argument("--as", dest="as_", default="claude", help="agent name shown in the browser (claude, codex, ...)")
    cl.set_defaults(fn=cmd_call)
    rp = sub.add_parser("replay", help="replay a recorded test (session export) with no LLM")
    rp.add_argument("file")
    rp.add_argument("-v", "--verbose", action="store_true")
    rp.set_defaults(fn=cmd_replay)
    rn = sub.add_parser("run", help="LangChain runner for API keys / Ollama (needs --extra runner)")
    rn.add_argument("rest", nargs=argparse.REMAINDER)
    rn.set_defaults(fn=cmd_run)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
