#!/usr/bin/env bash
# Zen Pilot installer: CLI + bridge service + MCP registration + browser extension.
#
#   curl -fsSL https://github.com/iput-object/zen-pilot/releases/latest/download/install.sh | bash
#   ./install.sh                 from a clone: installs this checkout
#   ./install.sh --uninstall     removes service, MCP entries and the CLI (keeps your sessions/notes)
#
# Env: ZEN_PILOT_REPO (owner/name), ZEN_PILOT_REF (git ref, default: latest release tag),
#      ZEN_PILOT_NO_EXTENSION=1 (skip the extension step).
set -euo pipefail

REPO="${ZEN_PILOT_REPO:-iput-object/zen-pilot}"
REF="${ZEN_PILOT_REF:-}"
XPI_DIR="$HOME/Downloads/zen-pilot" # Flatpak browsers can read ~/Downloads
ZEN_FLATPAK="app.zen_browser.zen"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
gh_ok() { have gh && gh auth status >/dev/null 2>&1; }

# Directory of this script when run from a clone (empty when piped from curl).
SRC=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "$d/pyproject.toml" && -d "$d/src/zen_pilot" ]] && SRC="$d"
fi

uninstall() {
  if have zen-pilot; then zen-pilot uninstall || true; fi
  if have uv; then uv tool uninstall zen-pilot 2>/dev/null || true; fi
  say "Removed. Remove the extension from the browser's add-ons page; data stays in ~/.local/share/zen-pilot."
}

ensure_uv() {
  if have uv; then return; fi
  say "Installing uv (Python package manager)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  have uv || die "uv installed but not on PATH; open a new shell and re-run"
}

latest_tag() {
  if gh_ok; then
    gh release view -R "$REPO" --json tagName -q .tagName 2>/dev/null || true
  else
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
      sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1
  fi
}

install_cli() {
  if [[ -n "$SRC" ]]; then
    say "Installing zen-pilot from $SRC"
    uv tool install --force --reinstall --python 3.12 "$SRC"
  else
    [[ -n "$REF" ]] || REF="$(latest_tag)"
    local url="https://github.com/$REPO"
    say "Installing zen-pilot from $url${REF:+ @ $REF}"
    if gh_ok; then gh auth setup-git >/dev/null 2>&1 || true; fi # private repos over https
    uv tool install --force --python 3.12 "git+$url${REF:+@$REF}"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  have zen-pilot || die "zen-pilot not on PATH; run 'uv tool update-shell' and re-run"
}

# Fetch a release asset into $2; returns 1 when there is no such asset.
fetch_asset() {
  local name="$1" dest="$2"
  if gh_ok; then
    if [[ -n "$REF" ]]; then
      gh release download "$REF" -R "$REPO" -p "$name" -O "$dest" --clobber 2>/dev/null
    else
      gh release download -R "$REPO" -p "$name" -O "$dest" --clobber 2>/dev/null
    fi
  else
    local base="https://github.com/$REPO/releases"
    local url="$base/latest/download/$name"
    [[ -n "$REF" ]] && url="$base/download/$REF/$name"
    curl -fsSL "$url" -o "$dest" 2>/dev/null
  fi
}

# Open a file in the user's Firefox-family browser (that shows the add-on install prompt).
open_in_browser() {
  local f="$1"
  if have flatpak && flatpak info "$ZEN_FLATPAK" >/dev/null 2>&1; then
    flatpak run "$ZEN_FLATPAK" "file://$f" >/dev/null 2>&1 &
  elif have zen-browser; then zen-browser "file://$f" >/dev/null 2>&1 &
  elif have zen; then zen "file://$f" >/dev/null 2>&1 &
  elif have firefox; then firefox "file://$f" >/dev/null 2>&1 &
  else return 1
  fi
}

install_extension() {
  [[ "${ZEN_PILOT_NO_EXTENSION:-}" == 1 ]] && return
  mkdir -p "$XPI_DIR"
  local xpi="$XPI_DIR/zen-pilot.xpi"
  if fetch_asset zen-pilot.xpi "$xpi"; then
    say "Extension downloaded: $xpi"
    if open_in_browser "$xpi"; then
      say "Your browser is asking to add Zen Pilot: click Add."
    else
      say "Install it: open $xpi in Zen/Firefox (or drag it onto the window)."
    fi
  else
    warn "no signed extension in the release yet. For now load it temporarily:"
    echo "    npx web-ext run -s extension --firefox=flatpak:$ZEN_FLATPAK   (from a clone)"
    echo "    or about:debugging → This Zen → Load Temporary Add-on → extension/manifest.json"
  fi
}

main() {
  case "${1:-}" in
    --uninstall) uninstall; return ;;
    -h | --help) sed -n '2,10p' "$0"; return ;;
    "") ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  [[ "$(uname -s)" == Linux ]] || die "the installer supports Linux only for now (needs systemd --user)"
  have curl || die "curl is required"
  ensure_uv
  install_cli
  say "Starting the bridge and registering MCP server 'zen'"
  zen-pilot install
  install_extension
  say "Done. Ask Claude Code or Codex: \"use the zen browser to …\""
}

main "$@"
