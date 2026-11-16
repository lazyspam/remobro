"""WebSocket bridge to the remobro extension in one or more browsers (JSON-RPC style).

Every browser with the extension connects to /ext and introduces itself with a hello
({browser, instance}). Calls go to one browser: the one a session is bound to, one picked
by name, or by default the browser the user focused last.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

log = logging.getLogger("remobro.bridge")

# Web pages can open sockets to localhost too, but their Origin is http(s)://…
EXTENSION_ORIGINS = ("moz-extension://", "chrome-extension://")


class BridgeError(RuntimeError):
    pass


@dataclass
class Conn:
    ws: WebSocket
    key: str  # stable per browser profile
    name: str  # "Zen", "Chrome", "Brave", …
    version: str = ""
    install_type: str = ""  # "development" = loaded unpacked (Chromium), "normal" = store/signed
    focused: float = field(default_factory=time.time)
    pending: dict[int, asyncio.Future] = field(default_factory=dict)


class Bridge:
    def __init__(self) -> None:
        self.conns: dict[str, Conn] = {}
        self.ids = itertools.count(1)
        self.changed = asyncio.Event()
        self.on_event: Callable[[dict, Conn], Awaitable[None]] | None = None
        self.on_connect: Callable[[Conn], Awaitable[None]] | None = None

    # ------------------------------------------------------------------ connections
    async def endpoint(self, ws: WebSocket) -> None:
        if not ws.headers.get("origin", "").startswith(EXTENSION_ORIGINS):
            await ws.close(code=4403)
            return
        await ws.accept()
        try:
            hello = await asyncio.wait_for(ws.receive_json(), 10)
        except (TimeoutError, WebSocketDisconnect, RuntimeError, ValueError):
            await ws.close()
            return
        key = str(hello.get("instance") or ws.headers.get("origin"))
        conn = Conn(ws, key, str(hello.get("browser") or "Browser"), str(hello.get("version") or ""), str(hello.get("installType") or ""))
        old = self.conns.get(key)
        self.conns[key] = conn
        if old is not None:  # same browser reconnected (extension reload, MV3 restart)
            self._fail_pending(old, "extension reconnected")
            try:
                await old.ws.close()
            except Exception:
                pass
        self.changed.set()
        log.info("%s connected (%s, extension %s)", conn.name, key[:8], conn.version)
        if self.on_connect:
            asyncio.create_task(self.on_connect(conn))
        try:
            while True:
                msg = await ws.receive_json()
                if "id" in msg and ("result" in msg or "error" in msg):
                    fut = conn.pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                elif msg.get("event") == "focus":
                    conn.focused = time.time()
                elif msg.get("event") == "ping":
                    pass  # keepalive from Chromium service workers
                elif "event" in msg and self.on_event:
                    asyncio.create_task(self.on_event(msg, conn))
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            if self.conns.get(key) is conn:
                del self.conns[key]
                self._fail_pending(conn, f"{conn.name} disconnected")
                log.info("%s disconnected", conn.name)

    @staticmethod
    def _fail_pending(conn: Conn, why: str) -> None:
        for fut in conn.pending.values():
            if not fut.done():
                fut.set_result({"error": why})
        conn.pending.clear()

    def browsers(self) -> list[Conn]:
        return sorted(self.conns.values(), key=lambda c: c.focused, reverse=True)

    async def wait_any(self, timeout: float = 4) -> None:
        end = time.time() + timeout
        while not self.conns and time.time() < end:
            self.changed.clear()
            try:
                await asyncio.wait_for(self.changed.wait(), max(0.05, end - time.time()))
            except TimeoutError:
                break

    def pick(self, key: str = "", name: str = "") -> Conn:
        """The browser to use: by key (a session's browser), by name, else the one used last."""
        if key and key in self.conns:
            return self.conns[key]
        if not self.conns:
            raise BridgeError(
                "No browser connected. Open your browser and make sure the remobro extension is installed and enabled."
            )
        if name:
            for c in self.browsers():
                if name.lower() in c.name.lower():
                    return c
            names = ", ".join(c.name for c in self.browsers())
            raise BridgeError(f"no connected browser matches {name!r} (connected: {names})")
        return self.browsers()[0]

    # ------------------------------------------------------------------ calls
    async def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 45, conn: Conn | None = None) -> Any:
        if conn is None:
            await self.wait_any()
            conn = self.pick()
        if self.conns.get(conn.key) is not conn:
            raise BridgeError(f"{conn.name} disconnected")
        rid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        conn.pending[rid] = fut
        await conn.ws.send_json({"id": rid, "method": method, "params": params or {}})
        try:
            msg = await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            conn.pending.pop(rid, None)
            raise BridgeError(f"{conn.name} did not answer {method} within {timeout:.0f}s") from None
        if "error" in msg:
            raise BridgeError(msg["error"])
        return msg.get("result")
