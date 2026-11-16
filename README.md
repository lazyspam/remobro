# remobro

Let any AI agent drive your **real, already-open browser** (Zen, Firefox): Claude Code and Codex on
your existing subscriptions, Gemini CLI, Cursor, or any model through LangChain (API keys
or local Ollama). Built for two jobs: browsing for you, and end-to-end testing websites.

```
 Claude Code ─┐                        ┌───────────── your real browser ───────────────┐
 Codex CLI ───┼─ MCP ─► remobro   ◄═ws═╪═► extension background ─► content scripts      │
 Gemini CLI ──┤  http   daemon         │     tabs, screenshots,     observe · act ·      │
 LangChain ───┘           │            │     network errors         overlay UI           │
                          ▼            └───────────────────────────────────────────────┘
               ~/.local/share/remobro     sessions · site notes · screenshots · tests
```

- **Works beside you.** Agents get their own tabs, in a tab group per session (`Claude · goal`),
  opened in the background. Your tabs are never touched. When an agent needs you (login, captcha,
  approval) you get a notification; clicking it opens the tab.
- **You can see it driving.** Agent tabs glow softly in the agent's colour. A floating bar shows
  `Claude is driving · click "Login"` with **Pause** and **Take over**. A named cursor moves along
  human-like paths, and typing is per character with natural rhythm. Both animate only while you
  watch the tab; in the background everything runs at full speed.
- **Token-frugal by design.** The agent looks at the page with the cheapest observation that answers
  its question, and every action reports what changed, so it rarely needs to look again.

## Token ladder

| Level | Tool | Returns | Typical cost |
|---|---|---|---|
| 0 | `open` / `act` results | page outline after navigation, or a change report | free (already returned) |
| 1 | `outline()` | landmarks, regions `rN`, headings, modals, notices | 150–400 tokens |
| 2 | `elements(region, filter)` | numbered controls, look-alike runs collapsed | 100–600 |
| 2b | `find("text" \| /re/)` | matching controls + snippets with nearest control | 50–200 |
| 3 | `read(rN \| heading, max_chars)` | article text (readability heuristic), paginated, `save=True` → file | capped |
| 4 | `look(id \| rN)` | cropped JPEG of one element/region | ~300–800 |
| 5 | `look("viewport" \| "full", marks=True)` | screenshot with element numbers drawn on | ~1–1.5k |

Other savings: batched `act([...])` steps, labels instead of ids (`{"do":"click","el":"Sign in"}`),
stable element numbers, dedup of repeated items, per-site notes injected on revisit, 10 tools with
terse schemas (~1.8k tokens total).

`act` change report example:

```
✓ fill 1 "Username"
✓ click 3 "Login"
navigated → https://example.com/secure
notice "You logged into a secure area!"
ERROR HTTP 500 POST example.com/api/session
```

## End-to-end testing

- `{"do":"expect","text"|"url"|"title"|"el":…, "not":true?}` assertions inside `act`.
- Console errors, uncaught exceptions, failed resources and first-party HTTP ≥ 400 responses show
  up as `ERROR` lines in every `act` result (third-party noise is counted, not listed); `errors()` lists all.
- Every session records its steps with label locators. `session(op="export")` writes a test file, and
  `remobro replay test.json` replays it **without any LLM** (zero tokens, exit code 1 on failure).

```bash
remobro replay ~/.local/share/remobro/sessions/<id>/test.json
# ok   open https://the-internet.herokuapp.com/login
# ok   7 step(s)
# PASSED 8 steps in 4.1s
```

## Install

Requirements: Linux with systemd, Zen (or Firefox) ≥ 128. The installer brings [uv](https://docs.astral.sh/uv/)
and Python if missing.

```bash
curl -fsSL https://github.com/iput-object/remobro/releases/latest/download/install.sh | bash
# or from a clone:
./install.sh
```

It installs the `remobro` CLI (`uv tool`), starts the bridge as a systemd user service, registers MCP
server `remobro` in Claude Code and Codex, and opens the signed extension in Zen so you can click **Add**.
Signed releases update themselves in Zen. `./install.sh --uninstall` removes everything except your
sessions and notes.

While the repo is private, the installer needs `gh auth login` to fetch releases.

### Extension development

```bash
npx web-ext run -s extension --firefox=flatpak:app.zen_browser.zen   # temp profile, reloads on change
```

### Releases

Push a tag (`git tag v0.3.0 && git push --tags`). The Release workflow sets that version, builds the
extension and the Python package, signs the extension as an unlisted add-on when the repo secrets
`AMO_JWT_ISSUER` / `AMO_JWT_SECRET` are set ([get keys](https://addons.mozilla.org/developers/addon/api/key/)),
and publishes `remobro.xpi`, `updates.json`, the wheel and `install.sh` to the GitHub release.

The toolbar icon shows `off` when the daemon isn't reachable.

Other MCP clients: `uv run remobro url` prints the endpoint (`http://127.0.0.1:8765/mcp?key=…`).

## Use

In Claude Code / Codex just ask: *"use remobro to …"*. From a shell:

```bash
remobro call session '{"op":"start","text":"check checkout flow"}'
remobro call open '{"url":"https://shop.example"}'
remobro call act '{"steps":[{"do":"click","el":"Add to cart"},{"do":"expect","text":"1 item"}]}'
remobro call session '{"op":"export"}'
```

Any model via LangChain: `uv sync --extra runner && uv run remobro run -m ollama:qwen3:14b "…"`.

Canvas apps (Figma, maps) work through coordinate steps (`click_at`, `drag`, `move`), keyboard
shortcuts (`press` with `repeat`) and `insert` for text editors, guided by `look("viewport")`.

## Safety

- The MCP endpoint needs a random key (`~/.config/remobro/key`); the extension socket accepts only
  `moz-extension://` origins, so websites can't talk to the bridge.
- Page text is treated as data, never instructions. Agents must `ask_user(kind="confirm")` before
  buying, sending, deleting or changing accounts, and hand logins/captchas to you.
- **Pause** / **Take over** in the floating bar stop the agent immediately.

## Layout

```
install.sh   installer · .github/workflows  CI + releases
extension/   content.js (observe, act, overlay) · background.js (bridge, tabs, screenshots, errors) · hook.js
src/remobro/  daemon.py (MCP tools) · bridge.py · store.py (sessions, site notes) · cli.py · runner.py (LangChain)
```
