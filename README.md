# remobro

Let AI agents drive your real browser: Claude Code, Codex, Gemini CLI, or any MCP client.
They work in their own background tabs, next to you, using as few tokens as possible.

Works with Zen and Firefox (128+) on Linux.

## Install

```bash
curl -fsSL https://github.com/iput-object/remobro/releases/latest/download/install.sh | bash
```

Then click **Add** when your browser asks. That's it. Remove with `install.sh --uninstall`.

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
npx web-ext run -s extension --firefox=flatpak:app.zen_browser.zen   # test the extension
git tag v0.3.0 && git push --tags                                    # release + sign
```

`extension/` is the browser side, `src/remobro/` the MCP bridge.
