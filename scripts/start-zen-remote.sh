#!/usr/bin/env bash
# (Re)start Zen (Flatpak) with remote control (Marionette) on. Only needed to auto-load the
# unsigned extension during development (scripts/dev-load-extension.py); normal use doesn't need it.
#   ./start-zen-remote.sh              your main profile (quits a running Zen first)
#   ./start-zen-remote.sh -P zen-mcp   a separate profile next to your normal Zen
#
# Safety: with remote control on, Firefox applies testing prefs that skip session restore,
# which loses open tabs. This script sets remote.prefs.recommended=false in every Zen profile
# and backs up the tab session before restarting.
set -euo pipefail
ZEN_DIR="${ZEN_DIR:-$HOME/.var/app/app.zen_browser.zen/.zen}"

for prof in "$ZEN_DIR"/*/; do
  [[ -f "$prof/prefs.js" ]] || continue
  if ! grep -qs 'remote.prefs.recommended' "$prof/user.js"; then
    echo 'user_pref("remote.prefs.recommended", false); // zen-pilot: keep normal behaviour under remote control' >> "$prof/user.js"
  fi
  if [[ -f "$prof/zen-sessions.jsonlz4" ]]; then
    mkdir -p "$prof/zen-pilot-backup"
    cp -a "$prof/zen-sessions.jsonlz4" "$prof/zen-pilot-backup/zen-sessions-$(date +%Y%m%d-%H%M%S).jsonlz4"
  fi
done

if [[ "${1:-}" != "-P" ]] && pgrep -f '^/app/zen/zen --name' >/dev/null; then
  echo "Quitting running Zen (tabs come back via session restore)..."
  pkill -TERM -f '^/app/zen/zen --name' || true
  for _ in $(seq 1 30); do pgrep -f '^/app/zen/zen --name' >/dev/null || break; sleep 0.5; done
fi
setsid nohup flatpak run app.zen_browser.zen "$@" --marionette --remote-debugging-port \
  >/dev/null 2>&1 < /dev/null &
for _ in $(seq 1 40); do ss -ltn | grep -q ':2828 ' && { echo "Zen ready for control on :2828"; exit 0; }; sleep 0.5; done
echo "Zen started but Marionette port 2828 is not open yet" >&2; exit 1
