"""WebSocket bridge to the remobro extension (JSON-RPC style, extension is the server-side of calls)."""

from __future__ import annotations

import asyncio
import itertools
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

log = logging.getLogger("remobro.bridge")


class BridgeError(RuntimeError):
    pass


class Bridge:
    def __init__(self) -> None:
        self.ws: WebSocket | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.ids = itertools.count(1)
        self.connected = asyncio.Event()
        self.on_event: Callable[[dict], Awaitable[None]] | None = None

    async def endpoint(self, ws: WebSocket) -> None:
        # Only our extension may connect: web pages can open sockets to localhost too,
        # but their Origin is http(s)://…, never moz-extension://.
        origin = ws.headers.get("origin", "")
        if not origin.startswith("moz-extension://"):
            await ws.close(code=4403)
            return
        await ws.accept()
        old, self.ws = self.ws, ws
        if old is not None:
            try:
                await old.close()
            except Exception:
                pass
        self.connected.set()
        log.info("extension connected (%s)", origin)
        try:
            while True:
                msg = await ws.receive_json()
                if "id" in msg and ("result" in msg or "error" in msg):
                    fut = self.pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                elif "event" in msg and self.on_event:
                    asyncio.create_task(self.on_event(msg))
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            if self.ws is ws:
                self.ws = None
                self.connected.clear()
                for fut in self.pending.values():
                    if not fut.done():
                        fut.set_result({"error": "remobro extension disconnected"})
                self.pending.clear()
                log.info("extension disconnected")

    async def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 45) -> Any:
        if self.ws is None:
            try:
                await asyncio.wait_for(self.connected.wait(), 4)
            except TimeoutError:
                raise BridgeError(
                    "No browser connected. Open your browser and make sure the remobro extension is installed and enabled."
                ) from None
        assert self.ws is not None
        rid = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        await self.ws.send_json({"id": rid, "method": method, "params": params or {}})
        try:
            msg = await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            self.pending.pop(rid, None)
            raise BridgeError(f"The browser did not answer {method} within {timeout:.0f}s") from None
        if "error" in msg:
            raise BridgeError(msg["error"])
        return msg.get("result")
