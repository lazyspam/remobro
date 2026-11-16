"""remobro runner: drive your browser with any LLM through LangChain (API keys or local Ollama).

Claude Code / Codex users don't need this: they talk to the remobro MCP server directly
with their subscription. This runner connects to the same daemon, so the model can be
anything `init_chat_model` understands:

    anthropic:claude-sonnet-5-5   openai:gpt-5.1   google_genai:gemini-3-pro
    ollama:qwen3:14b              openrouter:<model>   groq:<model>   deepseek:<model>

Usage:
    remobro run "find the cheapest 1TB NVMe on amazon.de"
    remobro run                    # interactive, keeps context between tasks
    remobro run -m ollama:qwen3:14b "..."
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from typing import Any

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ModelCallLimitMiddleware,
    ModelRequest,
)
from langchain.chat_models import init_chat_model
from langchain_core.messages import AIMessage, ToolMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.checkpoint.memory import InMemorySaver

load_dotenv()

DEFAULT_MODEL = os.getenv("REMOBRO_MODEL", "anthropic:claude-sonnet-5-5")
# Observation tools whose old results go stale after the page changes.
OBSERVATION_TOOLS = {"outline", "elements", "find", "read", "look"}

SYSTEM_PROMPT = """\
You operate the user's web browser through the remobro tools; follow their usage notes. \
Older page observations in this conversation may be replaced with a placeholder; they are stale. \
When done, reply with a short answer: the result and anything the user must do next."""


class StaleObservationMiddleware(AgentMiddleware):
    """Keep only the newest `keep` page observations in full.

    Old snapshots/page texts are the bulk of an agent's context and are stale once the
    page changes. They are replaced in the request (state is untouched) with a one-line
    placeholder. The rewrite is a pure function of the history, so the prompt prefix stays
    identical between consecutive calls except at the newly-stubbed message.
    """

    def __init__(self, keep: int = 1) -> None:
        super().__init__()
        self.keep = keep

    def _rewrite(self, request: ModelRequest) -> ModelRequest:
        obs_idx = [
            i for i, m in enumerate(request.messages)
            if isinstance(m, ToolMessage) and m.name in OBSERVATION_TOOLS
        ]
        stale = set(obs_idx[: -self.keep] if self.keep else obs_idx)
        if not stale:
            return request
        msgs = [
            ToolMessage(
                content=f"[stale {m.name} output removed to save tokens; call it again if needed]",
                tool_call_id=m.tool_call_id,
                name=m.name,
                id=m.id,
            ) if i in stale else m
            for i, m in enumerate(request.messages)
        ]
        return request.override(messages=msgs)

    def wrap_model_call(self, request, handler):
        return handler(self._rewrite(request))

    async def awrap_model_call(self, request, handler):
        return await handler(self._rewrite(request))


def build_model(spec: str):
    """Create the chat model, with provider-specific token savers."""
    provider = spec.split(":", 1)[0] if ":" in spec else ""
    middleware: list[AgentMiddleware] = [ModelCallLimitMiddleware(run_limit=60, exit_behavior="end")]

    if provider == "anthropic":
        # Claude: server-side tool-result clearing + prompt caching. Client-side history
        # rewriting is avoided here because newer Claude models reject replayed thinking
        # blocks after earlier messages were edited.
        from langchain_anthropic.middleware import AnthropicPromptCachingMiddleware

        model = init_chat_model(
            spec,
            max_tokens=16000,
            betas=["context-management-2025-06-27"],
            context_management={
                "edits": [{
                    "type": "clear_tool_uses_20250919",
                    "trigger": {"type": "input_tokens", "value": 25000},
                    "keep": {"type": "tool_uses", "value": 4},
                    "clear_at_least": {"type": "input_tokens", "value": 5000},
                }]
            },
        )
        middleware.append(AnthropicPromptCachingMiddleware(unsupported_model_behavior="ignore"))
    else:
        model = init_chat_model(spec)
        middleware.append(StaleObservationMiddleware(keep=1))
    return model, middleware


def mcp_connection() -> dict[str, Any]:
    from .daemon import mcp_url

    return {"transport": "streamable_http", "url": mcp_url()}


def _short(v: Any, n: int = 80) -> str:
    s = str(v).replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


async def run_task(agent, task: str, thread_id: str, usage: dict[str, int], verbose: bool) -> None:
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 150}
    final = ""
    async for chunk in agent.astream({"messages": [{"role": "user", "content": task}]},
                                     config=config, stream_mode="updates"):
        for update in chunk.values():
            for msg in (update or {}).get("messages", []) if isinstance(update, dict) else []:
                if isinstance(msg, AIMessage):
                    u = msg.usage_metadata or {}
                    usage["in"] += u.get("input_tokens", 0)
                    usage["out"] += u.get("output_tokens", 0)
                    usage["cached"] += (u.get("input_token_details") or {}).get("cache_read", 0)
                    for tc in msg.tool_calls:
                        args = ", ".join(f"{k}={_short(v, 40)}" for k, v in tc["args"].items())
                        print(f"  → {tc['name']}({args})", flush=True)
                    if not msg.tool_calls:
                        final = msg.text
                elif isinstance(msg, ToolMessage) and verbose:
                    print(f"    ← {_short(msg.text, 160)}", flush=True)
    print(f"\n{final}\n")


async def main_async(args: argparse.Namespace) -> None:
    model, middleware = build_model(args.model)
    client = MultiServerMCPClient({"remobro": mcp_connection()})

    # One persistent MCP session: the browser connection is reused across steps.
    async with client.session("remobro") as session:
        tools = await load_mcp_tools(session)

        agent = create_agent(
            model,
            tools=tools,
            system_prompt=SYSTEM_PROMPT,
            middleware=middleware,
            checkpointer=InMemorySaver(),
        )

        usage = {"in": 0, "out": 0, "cached": 0}
        thread = f"remobro-{int(time.time())}"
        print(f"remobro runner · model {args.model} · {len(tools)} tools")

        async def one(task: str) -> None:
            t0 = time.time()
            await run_task(agent, task, thread, usage, args.verbose)
            print(f"[{time.time() - t0:.1f}s · tokens in {usage['in']:,} "
                  f"(cached {usage['cached']:,}) · out {usage['out']:,}]")

        if args.task:
            await one(" ".join(args.task))
            return

        print("Type a task (empty line or Ctrl+D to quit, /new for a fresh context).")
        while True:
            try:
                task = (await asyncio.to_thread(input, "\nremobro> ")).strip()
            except (EOFError, KeyboardInterrupt):
                break
            if not task:
                break
            if task == "/new":
                thread = f"remobro-{int(time.time())}"
                print("New context.")
                continue
            try:
                await one(task)
            except KeyboardInterrupt:
                print("\nStopped.")


def main() -> None:
    p = argparse.ArgumentParser(prog="remobro run", description="Control your browser with any LLM (LangChain + remobro MCP).")
    p.add_argument("task", nargs="*", help="task to run; omit for interactive mode")
    p.add_argument("-m", "--model", default=DEFAULT_MODEL,
                   help=f"provider:model for init_chat_model (default {DEFAULT_MODEL})")
    p.add_argument("-v", "--verbose", action="store_true", help="print tool results")
    args = p.parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
