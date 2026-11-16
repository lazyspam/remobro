# remobro

Let AI agents drive your real browser: Claude Code, Codex, Gemini CLI, or any MCP client.
They work in their own background tabs, next to you, using as few tokens as possible.

Works with Zen, Firefox, Chrome, Brave, Edge and Chromium on Linux, several at once.

## Install

```bash
curl -fsSL https://github.com/iput-object/remobro/releases/latest/download/install.sh | bash
```

Zen/Firefox: click **Add** when it asks. Chrome & co: the installer opens `chrome://extensions`;
turn on **Developer mode** → **Load unpacked** → pick `~/Downloads/remobro/chromium`.
Remove with `install.sh --uninstall`.

## Use

Ask your agent: *"use remobro to check the checkout flow on shop.example"*.

- Agent tabs glow in the agent's colour, grouped per task. Your own tabs are never touched.
- A floating bar shows what it's doing. **Pause** hands you the tab; **Resume** lets it continue. Minimize it to a little bubble.
- For logins, captchas or anything risky (buying, sending, deleting) it asks you first.

## Testing websites

Every run is recorded. Export it and replay it later with no AI and zero tokens:

```bash
remobro replay ~/.local/share/remobro/sessions/<id>/test.json
# PASSED 8 steps in 4.1s
```

Agents can add assertions (`expect`), and console errors or failed requests show up in every result.

## DevTools

Agents can use the Chrome DevTools Protocol on their tab: run JavaScript, watch network and console,
read response bodies, measure performance (`devtools("Network.enable")`, `devtools("events")`, …).
In Zen/Firefox only running JavaScript is available.

## How it saves tokens

The agent reads a page in the cheapest way that answers its question: a short outline first, then
specific elements or text, and a screenshot only when needed. Every action reports what changed, so it
rarely has to look again:

```
✓ click 3 "Login"
navigated → https://example.com/secure
notice "You logged into a secure area!"
```

## Development

```bash
uv sync
npx web-ext run --firefox=flatpak:app.zen_browser.zen    # try the extension in Zen
scripts/build-chromium.sh                                  # Chromium build → dist/chromium
git tag v0.3.0 && git push --tags                         # release + sign
```

`extension/` is the browser side, `src/remobro/` the MCP bridge.
