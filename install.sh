#!/usr/bin/env bash
# remobro installer: CLI + bridge service + MCP registration + browser extension.
#
#   curl -fsSL https://github.com/iput-object/remobro/releases/latest/download/install.sh | bash
#   ./install.sh                 from a clone: installs this checkout (needs uv)
#   ./install.sh --uninstall     removes service, MCP entries and the CLI (keeps your sessions/notes)
#
# Env: REMOBRO_VERSION (release tag, default: latest), REMOBRO_NO_EXTENSION=1 (skip the extension).
set -euo pipefail

REPO="iput-object/remobro"
VERSION="${REMOBRO_VERSION:-}"
BIN_DIR="$HOME/.local/bin"
XPI_DIR="$HOME/Downloads/remobro" # extension files; Flatpak browsers can read ~/Downloads
ZEN_FLATPAK="app.zen_browser.zen"
USER_PATH="$PATH"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

asset_url() {
  if [[ -n "$VERSION" ]]; then echo "https://github.com/$REPO/releases/download/$VERSION/$1"
  else echo "https://github.com/$REPO/releases/latest/download/$1"; fi
}

# Directory of this script when run from a clone (empty when piped from curl).
SRC=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "$d/pyproject.toml" && -d "$d/src/remobro" ]] && SRC="$d"
fi

uninstall() {
  if have remobro; then remobro uninstall || true; fi
  if have uv; then uv tool uninstall remobro >/dev/null 2>&1 || true; fi
  [[ -f "$BIN_DIR/remobro" && ! -L "$BIN_DIR/remobro" ]] && rm -f "$BIN_DIR/remobro"
  say "Removed. Remove the extension from the browser's add-ons page; data stays in ~/.local/share/remobro."
}

# Release binary: no Python or uv needed. Returns 1 if there is none for this machine.
install_binary() {
  local arch
  case "$(uname -m)" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=aarch64 ;;
    *) return 1 ;;
  esac
  local tmp
  tmp="$(mktemp)"
  say "Downloading remobro ${VERSION:-latest} (linux-$arch)"
  curl -fsSL "$(asset_url "remobro-linux-$arch")" -o "$tmp" || { rm -f "$tmp"; return 1; }
  chmod +x "$tmp"
  "$tmp" --help >/dev/null || { rm -f "$tmp"; die "the downloaded binary does not run on this system"; }
  if have uv; then uv tool uninstall remobro >/dev/null 2>&1 || true; fi # replace an older uv install
  mkdir -p "$BIN_DIR"
  mv -f "$tmp" "$BIN_DIR/remobro"
}

# From source with uv (clones, or machines without a release binary).
install_with_uv() {
  if ! have uv; then
    say "Installing uv (Python package manager)"
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  export PATH="$BIN_DIR:$PATH"
  if [[ -n "$SRC" ]]; then
    say "Installing remobro from $SRC"
    uv tool install --force --reinstall --python 3.12 "$SRC"
  else
    say "Installing remobro from source"
    uv tool install --force --python 3.12 "git+https://github.com/$REPO${VERSION:+@$VERSION}"
  fi
}

# Firefox family (Zen, Firefox, …): open the signed .xpi, the browser shows "Add remobro?".
firefox_browser() {
  if have flatpak && flatpak info "$ZEN_FLATPAK" >/dev/null 2>&1; then echo "flatpak run $ZEN_FLATPAK"; return; fi
  local b
  for b in zen-browser zen firefox librewolf floorp; do have "$b" && { echo "$b"; return; }; done
  return 1
}
# Chromium family (Chrome, Brave, Edge, Chromium, Vivaldi)
chromium_browser() {
  local b
  for b in google-chrome-stable google-chrome chromium chromium-browser brave brave-browser microsoft-edge-stable microsoft-edge vivaldi-stable vivaldi; do
    have "$b" && { echo "$b"; return; }
  done
  return 1
}

install_firefox_extension() {
  local open xpi="$XPI_DIR/remobro.xpi"
  open="$(firefox_browser)" || return 0
  curl -fsSL "$(asset_url remobro.xpi)" -o "$xpi" || { warn "could not download remobro.xpi"; return 0; }
  $open "file://$xpi" >/dev/null 2>&1 &
  say "Zen/Firefox is asking to add remobro: click Add."
}

install_chromium_extension() {
  local open dir="$XPI_DIR/chromium" zip
  open="$(chromium_browser)" || return 0
  zip="$(mktemp)"
  curl -fsSL "$(asset_url remobro-chromium.zip)" -o "$zip" || { rm -f "$zip"; warn "could not download remobro-chromium.zip"; return 0; }
  rm -rf "$dir" && mkdir -p "$dir"
  if have unzip; then unzip -oq "$zip" -d "$dir"; else python3 -m zipfile -e "$zip" "$dir"; fi
  rm -f "$zip"
  $open chrome://extensions >/dev/null 2>&1 &
  say "In $open (chrome://extensions): turn on Developer mode → Load unpacked → pick $dir"
  say "  (already loaded? just click the reload icon on remobro)"
}

install_extension() {
  [[ "${REMOBRO_NO_EXTENSION:-}" == 1 ]] && return
  mkdir -p "$XPI_DIR"
  if ! firefox_browser >/dev/null && ! chromium_browser >/dev/null; then
    warn "no supported browser found; get the extension from https://github.com/$REPO/releases"
    return
  fi
  install_firefox_extension
  install_chromium_extension
}

main() {
  case "${1:-}" in
    --uninstall) uninstall; return ;;
    -h | --help) sed -n '2,8p' "${BASH_SOURCE[0]:-$0}"; return ;;
    "") ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
  [[ "$(uname -s)" == Linux ]] || die "the installer supports Linux only for now (needs systemd --user)"
  have curl || die "curl is required"

  if [[ -n "$SRC" ]] || ! install_binary; then install_with_uv; fi
  export PATH="$BIN_DIR:$PATH"
  have remobro || die "remobro is not on PATH"

  say "Starting the bridge and registering MCP server 'remobro'"
  remobro install
  install_extension
  case ":$USER_PATH:" in *":$BIN_DIR:"*) ;; *) warn "add $BIN_DIR to your PATH to use the remobro command" ;; esac
  say "Done. Ask Claude Code or Codex: \"use remobro to …\""
}

main "$@"
