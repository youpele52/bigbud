#!/bin/sh
# Stage a bigbud remote agent build on this Linux host for bigbud to adopt.
#
# Usage (bigbud shows this command with the version already pinned):
#   curl -fsSL https://bigbud.app/remote-agent.sh | BIGBUD_AGENT_VERSION=<version> sh
#
# This script only downloads, verifies the SHA-256 published for the pinned release and places
# the bytes in a private inbox (~/.bigbud/agent/inbox/<sha256>/). It never executes the
# download, never touches the installation registry or the active build, and never activates
# anything. Return to bigbud and choose "Finish install/update" to verify the release signature,
# register and activate the build.

set -eu

REPO="${BIGBUD_RELEASE_REPOSITORY:-youpele52/bigbud}"
VERSION="${BIGBUD_AGENT_VERSION:-}"
MAX_AGENT_BYTES=67108864
MAX_METADATA_BYTES=1048576

log() { printf '%s\n' "$*" >&2; }
fail() {
  code=$1
  shift
  log "bigbud remote agent: $*"
  exit "$code"
}

case "$VERSION" in
  "") fail 2 "BIGBUD_AGENT_VERSION is required. Copy the pinned command from bigbud." ;;
  [A-Za-z0-9]*) ;;
  *) fail 2 "BIGBUD_AGENT_VERSION '$VERSION' is invalid." ;;
esac
case "$VERSION" in *[!A-Za-z0-9._+-]*) fail 2 "BIGBUD_AGENT_VERSION '$VERSION' is invalid." ;; esac
[ "${#VERSION}" -le 64 ] || fail 2 "BIGBUD_AGENT_VERSION is too long."
case "$REPO" in
  */*/* | /* | */ | *[!A-Za-z0-9_./-]*) fail 2 "BIGBUD_RELEASE_REPOSITORY must be owner/repository." ;;
  */*) ;;
  *) fail 2 "BIGBUD_RELEASE_REPOSITORY must be owner/repository." ;;
esac

[ "$(uname -s)" = Linux ] || fail 3 "Only Linux hosts are supported (found $(uname -s))."
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) fail 3 "Unsupported CPU architecture $(uname -m)." ;;
esac
host_libc=glibc
if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then host_libc=musl; fi

for tool in sha256sum awk mktemp stat head mkfifo wc flock; do
  command -v "$tool" >/dev/null 2>&1 || fail 3 "Missing required command: $tool"
done
if command -v curl >/dev/null 2>&1; then
  downloader=curl
elif command -v wget >/dev/null 2>&1; then
  downloader=wget
else
  fail 3 "Missing required command: curl or wget"
fi

# Bound actual bytes, including chunked responses and older curl versions. Keep the
# downloader's exit status: a short partial response must never count as success.
bounded_fetch() {
  url=$1 limit=$2 destination=$3
  pipe="$destination.pipe"
  fetch_pid=""
  reader_pid=""
  fetch_cleanup() {
    if [ -n "$reader_pid" ]; then
      kill "$reader_pid" 2>/dev/null || true
      wait "$reader_pid" 2>/dev/null || true
    fi
    if [ -n "$fetch_pid" ]; then
      kill "$fetch_pid" 2>/dev/null || true
      wait "$fetch_pid" 2>/dev/null || true
    fi
    rm -f -- "$pipe"
  }
  trap fetch_cleanup EXIT
  trap 'exit 130' HUP INT TERM
  mkfifo -m 600 "$pipe" || exit 1
  if [ "$downloader" = curl ]; then
    curl -fsSL --proto '=https' --proto-redir '=https' --max-time 180 "$url" >"$pipe" &
  else
    wget -q --https-only --max-redirect=5 --timeout=30 --tries=1 -O - "$url" >"$pipe" &
  fi
  fetch_pid=$!
  head -c "$((limit + 1))" <"$pipe" >"$destination" &
  reader_pid=$!
  wait "$reader_pid" || exit 1
  reader_pid=""
  actual=$(wc -c <"$destination")
  [ "$actual" -le "$limit" ] || exit 1
  fetch_status=0
  wait "$fetch_pid" || fetch_status=$?
  fetch_pid=""
  exit "$fetch_status"
}

fetch() {
  bounded_fetch "$@" &
  fetch_job=$!
  result=0
  wait "$fetch_job" || result=$?
  fetch_job=""
  return "$result"
}

release_url="https://github.com/$REPO/releases/download/v$VERSION"
agent_root="$HOME/.bigbud/agent"
inbox="$agent_root/inbox"
umask 077

# Owner-only directories, matching what bigbud enforces before adoption.
ensure_private_dir() {
  if [ -L "$1" ] || { [ -e "$1" ] && [ ! -d "$1" ]; }; then
    fail 7 "$1 must be a real directory. Remove or rename it, then retry."
  fi
  if [ ! -e "$1" ]; then mkdir -m 700 "$1" || fail 7 "Could not create $1."; fi
  [ "$(stat -c '%u' "$1")" = "$(id -u)" ] || fail 7 "$1 is not owned by $(id -un)."
  mode=$(stat -c '%a' "$1")
  [ "$mode" = 700 ] || fail 7 "$1 has mode $mode; run: chmod 700 '$1'"
}
[ -d "$HOME/.bigbud" ] || mkdir -m 700 "$HOME/.bigbud" || fail 7 "Could not create ~/.bigbud."
ensure_private_dir "$agent_root"
ensure_private_dir "$inbox"
# Shared with app adoption; never unlink this lock file while another process may hold it.
[ ! -L "$inbox/.claim.lock" ] || fail 7 "Inbox claim lock must not be a symbolic link."
exec 8>"$inbox/.claim.lock"
flock -n 8 || fail 8 "bigbud is adopting or staging this inbox. Retry after it finishes."

lock="$inbox/.download.lock"
mkdir "$lock" 2>/dev/null ||
  fail 8 "Another download is staging in $inbox. If none is running, remove '$lock' and retry."
work=""
fetch_job=""
cleanup() {
  if [ -n "$fetch_job" ]; then
    kill "$fetch_job" 2>/dev/null || true
    wait "$fetch_job" 2>/dev/null || true
  fi
  [ -z "$work" ] || rm -rf -- "$work"
  rmdir -- "$lock" 2>/dev/null || true
}
trap cleanup EXIT
for partial in "$inbox"/.partial.*; do
  [ -e "$partial" ] || [ -L "$partial" ] || continue
  fail 8 "An interrupted download remains at '$partial'. Inspect and remove that exact path before retrying."
done
work=$(mktemp -d "$inbox/.partial.XXXXXX") || fail 4 "Could not create a private download directory."
trap 'exit 130' HUP INT TERM

# Read the release manifest for this exact version (musl-aware v2 first, then legacy).
source_file="$work/install-source.json"
fetch "$release_url/remote-agent-install-source.v2.json" "$MAX_METADATA_BYTES" "$source_file" 2>/dev/null ||
  fetch "$release_url/remote-agent-install-source.json" "$MAX_METADATA_BYTES" "$source_file" ||
  fail 4 "Could not download the release manifest for v$VERSION from $release_url."

# Print "SIZE SHA256" for TRIPLE. Manifest artifacts list targetTriple before sizeBytes/sha256.
manifest_entry() {
  tr ',{}' '\n\n\n' <"$source_file" | awk -v want="$1" '
    function value(line) { sub(/^[^:]*:[[:space:]]*/, "", line); gsub(/["[:space:]]/, "", line); return line }
    /"targetTriple"[[:space:]]*:/ { current = value($0); size = ""; sha = "" }
    /"sizeBytes"[[:space:]]*:/ && current == want { size = value($0) }
    /"sha256"[[:space:]]*:/ && current == want { sha = value($0) }
    current == want && size != "" && sha != "" { print size, sha; exit }'
}

triple=""
for candidate in "$arch-unknown-linux-musl" "$arch-unknown-linux-gnu"; do
  [ "$host_libc" = musl ] && [ "${candidate##*-}" = gnu ] && continue
  entry=$(manifest_entry "$candidate")
  if [ -n "$entry" ]; then triple=$candidate; break; fi
done
[ -n "$triple" ] || fail 3 "Release v$VERSION has no agent build for $arch ($host_libc)."
size=${entry%% *}
sha=${entry#* }
case "$size" in "" | *[!0-9]*) fail 5 "The release manifest has an invalid size for $triple." ;; esac
[ "${#sha}" -eq 64 ] || fail 5 "The release manifest has an invalid SHA-256 for $triple."
case "$sha" in *[!a-f0-9]*) fail 5 "The release manifest has an invalid SHA-256 for $triple." ;; esac
[ "$size" -le "$MAX_AGENT_BYTES" ] || fail 5 "The agent build is larger than expected."

verified() {
  [ -f "$1" ] && [ ! -L "$1" ] &&
    [ "$(wc -c <"$1" | tr -d ' ')" -eq "$size" ] &&
    [ "$(sha256sum "$1" | awk '{print $1}')" = "$sha" ]
}

target_dir="$inbox/$sha"
target="$target_dir/bigbud-remote-agent"
next_step() {
  log "Staged bigbud remote agent $VERSION ($triple) in $target_dir."
  log "Nothing is active yet. Return to bigbud and choose \"Finish install/update\" to verify,"
  log "register and activate this build."
}
if verified "$target"; then
  next_step
  exit 0
fi
if [ -e "$target" ] || [ -L "$target" ]; then
  fail 6 "$target exists but does not match release v$VERSION. Inspect it, remove it with: rm -r '$target_dir', then retry."
fi

# Keep at most one completed candidate; report others instead of deleting unknown content.
for existing in "$inbox"/*; do
  [ -e "$existing" ] || continue
  [ "$existing" = "$target_dir" ] && continue
  fail 6 "Another staged build is waiting in $existing. Finish it in bigbud or remove it with: rm -r '$existing', then retry."
done

download="$work/bigbud-remote-agent"
fetch "$release_url/bigbud-remote-agent-$VERSION-$triple" "$MAX_AGENT_BYTES" "$download" ||
  fail 4 "Could not download bigbud-remote-agent-$VERSION-$triple from $release_url."
verified "$download" || fail 5 "The downloaded agent does not match the SHA-256 published for v$VERSION."
chmod 700 "$download"

[ -d "$target_dir" ] || mkdir -m 700 "$target_dir" || fail 7 "Could not create $target_dir."
ensure_private_dir "$target_dir"
# Same-filesystem rename publishes the complete, verified file atomically.
mv -f -- "$download" "$target" || fail 7 "Could not place the agent in $target_dir."
verified "$target" || fail 5 "The staged agent failed verification after placement."
next_step
