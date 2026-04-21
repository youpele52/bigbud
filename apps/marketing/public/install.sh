#!/bin/sh

set -eu

REPO="youpele52/bigbud"
LATEST_RELEASE_API_URL="https://api.github.com/repos/$REPO/releases/latest"
RELEASES_API_URL="https://api.github.com/repos/$REPO/releases"
RELEASES_PAGE_URL="https://github.com/$REPO/releases"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "bigbud installer: $*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

http_get() {
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "User-Agent: bigbud-installer" \
    "$1"
}

fetch_release_payload() {
  latest_payload=""
  if latest_payload="$(http_get "$LATEST_RELEASE_API_URL" 2>/dev/null)"; then
    if printf '%s' "$latest_payload" | grep -q '"browser_download_url"'; then
      printf '%s' "$latest_payload"
      return 0
    fi
  fi

  all_payload="$(http_get "$RELEASES_API_URL")" || return 1
  if [ "$all_payload" = "[]" ]; then
    fail "No GitHub releases are available yet. Visit $RELEASES_PAGE_URL"
  fi

  printf '%s' "$all_payload"
}

extract_asset_urls() {
  printf '%s' "$1" |
    grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' |
    sed 's/^.*"browser_download_url"[[:space:]]*:[[:space:]]*"//; s/"$//'
}

pick_asset_url() {
  payload="$1"
  shift

  urls="$(extract_asset_urls "$payload")"
  for pattern in "$@"; do
    match="$(printf '%s\n' "$urls" | grep -E "$pattern" | head -n 1 || true)"
    if [ -n "$match" ]; then
      printf '%s' "$match"
      return 0
    fi
  done

  return 1
}

detect_os() {
  case "$(uname -s)" in
    Darwin)
      printf 'mac'
      ;;
    Linux)
      printf 'linux'
      ;;
    *)
      fail "Unsupported operating system. This installer supports macOS and Linux."
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      printf 'x64'
      ;;
    arm64|aarch64)
      printf 'arm64'
      ;;
    *)
      fail "Unsupported CPU architecture: $(uname -m)"
      ;;
  esac
}

make_temp_dir() {
  if tmp_dir="$(mktemp -d 2>/dev/null)"; then
    printf '%s' "$tmp_dir"
    return 0
  fi

  mktemp -d -t bigcode-install
}

install_macos() {
  require_command hdiutil
  require_command ditto

  asset_url="$1"
  tmp_dir="$2"
  dmg_path="$tmp_dir/bigcode.dmg"
  mount_dir="$tmp_dir/mount"

  mkdir -p "$mount_dir"

  log "Downloading macOS installer..."
  curl -fL "$asset_url" -o "$dmg_path"

  log "Mounting disk image..."
  hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null

  set -- "$mount_dir"/*.app
  if [ ! -d "$1" ]; then
    fail "Could not find an app bundle inside the mounted DMG."
  fi

  app_bundle="$1"
  app_name="$(basename "$app_bundle")"
  destination="/Applications/$app_name"

  log "Installing $app_name to /Applications..."
  if [ -w /Applications ]; then
    ditto "$app_bundle" "$destination"
  elif command -v sudo >/dev/null 2>&1; then
    sudo ditto "$app_bundle" "$destination"
  else
    fail "Administrator access is required to install into /Applications."
  fi

  log "Installed $app_name to $destination"
}

install_linux() {
  asset_url="$1"
  tmp_dir="$2"
  install_dir="${BIGBUD_INSTALL_DIR:-$HOME/.local/bin}"
  desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  app_path="$install_dir/bigcode.AppImage"
  desktop_path="$desktop_dir/bigcode.desktop"
  download_path="$tmp_dir/bigcode.AppImage"

  mkdir -p "$install_dir" "$desktop_dir"

  log "Downloading Linux AppImage..."
  curl -fL "$asset_url" -o "$download_path"
  install -m 0755 "$download_path" "$app_path"

  cat >"$desktop_path" <<EOF
[Desktop Entry]
Type=Application
Name=bigbud
Exec="$app_path"
TryExec="$app_path"
Terminal=false
Categories=Development;
StartupWMClass=bigcode
EOF

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true
  fi

  log "Installed bigbud to $app_path"
  log "Desktop entry written to $desktop_path"
}

main() {
  require_command curl
  require_command grep
  require_command sed

  os="$(detect_os)"
  arch="$(detect_arch)"
  payload="$(fetch_release_payload)"
  tmp_dir="$(make_temp_dir)"
  mount_dir="$tmp_dir/mount"

  cleanup() {
    if [ -d "$mount_dir" ]; then
      hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
    fi
    rm -rf "$tmp_dir"
  }
  trap cleanup EXIT INT TERM HUP

  case "$os/$arch" in
    mac/arm64)
      asset_url="$(pick_asset_url "$payload" '/bigbud-[^/"]+-arm64\.dmg$' '/bigbud-[^/"]+\.dmg$')" ||
        fail "Could not find a macOS arm64 DMG in the GitHub release. Visit $RELEASES_PAGE_URL"
      install_macos "$asset_url" "$tmp_dir"
      ;;
    mac/x64)
      asset_url="$(pick_asset_url "$payload" '/bigbud-[^/"]+-x64\.dmg$' '/bigbud-[^/"]+\.dmg$')" ||
        fail "Could not find a macOS x64 DMG in the GitHub release. Visit $RELEASES_PAGE_URL"
      install_macos "$asset_url" "$tmp_dir"
      ;;
    linux/x64)
      asset_url="$(pick_asset_url "$payload" '/bigbud-[^/"]+-x64\.AppImage$' '/bigbud-[^/"]+\.AppImage$')" ||
        fail "Could not find a Linux x64 AppImage in the GitHub release. Visit $RELEASES_PAGE_URL"
      install_linux "$asset_url" "$tmp_dir"
      ;;
    linux/arm64)
      asset_url="$(pick_asset_url "$payload" '/bigbud-[^/"]+-arm64\.AppImage$')" ||
        fail "Linux arm64 builds are not published yet. Visit $RELEASES_PAGE_URL"
      install_linux "$asset_url" "$tmp_dir"
      ;;
    *)
      fail "Unsupported platform combination: $os/$arch"
      ;;
  esac

  log "Done."
}

main "$@"
