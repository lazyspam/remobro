"""Sessions and site notes, persisted as small JSON files.

A session is one task: its goal, tabs, notes, visited pages and an action log. Any agent
can resume it, so work can move between Claude, Codex, etc. with ~300 tokens of context.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

DATA_DIR = Path(os.environ.get("REMOBRO_HOME", Path.home() / ".local/share/remobro"))

# data from before the rename (zen-pilot) moves over once
_OLD_DIR = Path.home() / ".local/share/zen-pilot"
if "REMOBRO_HOME" not in os.environ and _OLD_DIR.is_dir() and not DATA_DIR.exists():
    _OLD_DIR.rename(DATA_DIR)


@dataclass
class Session:
    id: str
    goal: str
    agent: str
    color: str
    color_name: str
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)
    status: str = "active"  # active | paused | ended
    tabs: list[int] = field(default_factory=list)
    current_tab: int | None = None
    group_id: int | None = None
    browser: str = ""  # bridge key of the browser this session's tabs live in
    browser_name: str = ""
    notes: dict[str, str] = field(default_factory=dict)
    pages: dict[str, str] = field(default_factory=dict)  # url -> title
    log: list[str] = field(default_factory=list)
    tokens: int = 0
    steps: int = 0
    summary: str = ""
    sites_noted: list[str] = field(default_factory=list)  # hosts whose site notes were shown
    script: list[dict] = field(default_factory=list)  # replayable steps (label locators, no ids)

    @property
    def dir(self) -> Path:
        d = DATA_DIR / "sessions" / self.id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def record(self, tool: str, detail: str, out_chars: int) -> None:
        self.steps += 1
        self.tokens += out_chars // 4
        self.updated = time.time()
        self.log.append(f"{time.strftime('%H:%M:%S')} {tool} {detail}"[:160])
        self.log = self.log[-200:]

    def state(self) -> str:
        lines = [
            f"session {self.id} [{self.status}] by {self.agent}: {self.goal}",
            f"{self.steps} tool calls, ~{self.tokens:,} result tokens",
        ]
        if self.notes:
            lines.append("notes:")
            lines += [f"  {k}: {v}" for k, v in self.notes.items()]
        if self.pages:
            lines.append(f"pages visited ({len(self.pages)}), latest:")
            lines += [f"  {t[:60]} — {u[:100]}" for u, t in list(self.pages.items())[-6:]]
        if self.log:
            lines.append("recent actions:")
            lines += [f"  {entry}" for entry in self.log[-8:]]
        if self.summary:
            lines.append(f"summary: {self.summary}")
        return "\n".join(lines)


class Store:
    def __init__(self) -> None:
        (DATA_DIR / "sessions").mkdir(parents=True, exist_ok=True)
        self.sessions: dict[str, Session] = {}
        self.site_file = DATA_DIR / "site_notes.json"

    # sessions -----------------------------------------------------------
    def new(self, goal: str, agent: str, color: str, color_name: str) -> Session:
        sid = time.strftime("%m%d-") + secrets.token_hex(2)
        s = Session(id=sid, goal=goal, agent=agent, color=color, color_name=color_name)
        self.sessions[sid] = s
        self.save(s)
        return s

    def get(self, sid: str) -> Session | None:
        if sid in self.sessions:
            return self.sessions[sid]
        f = DATA_DIR / "sessions" / sid / "session.json"
        if f.exists():
            s = Session(**json.loads(f.read_text()))
            self.sessions[sid] = s
            return s
        return None

    def save(self, s: Session) -> None:
        f = s.dir / "session.json"
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(s), indent=1))
        tmp.replace(f)

    def recent(self, n: int = 10) -> list[Session]:
        out = []
        for f in (DATA_DIR / "sessions").glob("*/session.json"):
            try:
                out.append(self.get(f.parent.name))
            except Exception:
                continue
        return sorted([s for s in out if s], key=lambda s: s.updated, reverse=True)[:n]

    # site notes --------------------------------------------------------
    def site_notes(self) -> dict[str, list[str]]:
        try:
            return json.loads(self.site_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def notes_for(self, host: str) -> list[str]:
        host = host.removeprefix("www.")
        return self.site_notes().get(host, [])

    def add_site_note(self, host: str, note: str) -> None:
        host = host.removeprefix("www.")
        data = self.site_notes()
        items = data.setdefault(host, [])
        if note not in items:
            items.append(note)
        data[host] = items[-12:]
        self.site_file.write_text(json.dumps(data, indent=1))
