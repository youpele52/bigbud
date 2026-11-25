//! Fixed recipes for `agent_action`. Every program, argument, working
//! directory and environment value is compiled in; the wire contributes only
//! the verb, an operation id and, for INSTALL/UPDATE, validated artifact data.

use super::{ActionKind, Artifact};
use crate::{
    transport::{RecipeOutput, Transport},
    v1::ErrorCode,
};
use std::time::Duration;

const PLATFORM_TIMEOUT: Duration = Duration::from_secs(8);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
const PLATFORM_LIMIT: usize = 4 * 1024;
const INSTALL_LIMIT: usize = 64 * 1024;
const STATUS_LIMIT: usize = 1024 * 1024 + 16;
const CONTROL_LIMIT: usize = 2 * 1024 * 1024;

const PLATFORM_PROBE: &str = r#"printf '%s\n%s\n' "$(uname -s)" "$(uname -m)"
if [ "$(uname -s)" = Linux ]; then
  if command -v ldd >/dev/null 2>&1; then
    libc=$(ldd --version 2>&1 | head -n 2 | tr '\n' ' ')
  else libc=missing; fi
  printf 'libc=%s\n' "$libc"
  for tool in sha256sum flock base64 mktemp awk install stat readlink sync; do
    if command -v "$tool" >/dev/null 2>&1; then printf 'tool.%s=yes\n' "$tool"
    else printf 'tool.%s=no\n' "$tool"; fi
  done
  if stat -c '%a' / >/dev/null 2>&1; then printf 'feature.stat-c=yes\n'
  else printf 'feature.stat-c=no\n'; fi
  if readlink -f -- / >/dev/null 2>&1; then printf 'feature.readlink-f=yes\n'
  else printf 'feature.readlink-f=no\n'; fi
  if sync -f /dev/null >/dev/null 2>&1; then printf 'feature.sync-f=yes\n'
  else printf 'feature.sync-f=no\n'; fi
  for dir in .bigbud/agent .bigbud/agent/bin .bigbud/agent/staging; do
    path="$HOME/$dir"
    if [ -L "$path" ]; then printf 'dir.%s=symlink\n' "$dir"
    elif [ ! -e "$path" ]; then printf 'dir.%s=absent\n' "$dir"
    elif [ ! -d "$path" ]; then printf 'dir.%s=not-a-directory\n' "$dir"
    else
      owner=other
      [ "$(stat -c '%u' "$path" 2>/dev/null)" = "$(id -u)" ] && owner=self
      printf 'dir.%s=mode=%s,owner=%s\n' "$dir" "$(stat -c '%a' "$path" 2>/dev/null)" "$owner"
    fi
  done
fi"#;

const STATUS: &str = r#"test -d "$HOME" && test -x "$HOME" || { printf unreadable; exit 0; }
for d in "$HOME/.bigbud" "$HOME/.bigbud/agent" "$HOME/.bigbud/agent/control-v1"; do
  if [ ! -e "$d" ] && [ ! -L "$d" ]; then printf absent; exit 0; fi
  test -d "$d" && test ! -L "$d" && test -x "$d" || { printf unreadable; exit 0; }
done
f="$HOME/.bigbud/agent/control-v1/registry.json"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then printf absent
elif [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] && [ "$(wc -c < "$f")" -le 1048576 ]; then cat -- "$f"
else printf unreadable; fi"#;

const START: &str = r#"set -u
binary="$HOME/.bigbud/agent/bin/current"
socket="$HOME/.bigbud/agent/state/supervisor.sock"
log="$HOME/.bigbud/agent/state/supervisor.log"
test ! -L "$HOME/.bigbud/agent/state" || { printf 'unsafe-state\n' >&2; exit 13; }
status=0
if test -x "$binary"; then "$binary" --prepare-supervisor || status=$?; else status=12; fi
if [ "$status" -eq 12 ]; then printf 'not-installed\n' >&2; exit 12; fi
if [ "$status" -eq 10 ]; then
  : > "$log" 2>/dev/null || true
  "$binary" --supervisor >/dev/null 2>"$log" &
  supervisor_pid=$!
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if [ -S "$socket" ] && "$binary" --prepare-supervisor; then status=0; break; fi
    sleep 0.1
  done
  if [ "$status" -ne 0 ]; then
    if [ -s "$log" ]; then cat "$log" >&2; fi
    wait "$supervisor_pid" || true
    exit 1
  fi
fi
if [ "$status" -ne 0 ]; then exit "$status"; fi
printf started"#;

const STOP: &str = r#"set -u
binary="$HOME/.bigbud/agent/bin/current"
test -x "$binary" || { printf 'not-installed\n' >&2; exit 12; }
BIGBUD_AGENT_STATE_DIR="$HOME/.bigbud/agent/state" "$binary" --shutdown-supervisor
printf stopped"#;

const WAKE: &str = r#"set -u
binary="$HOME/.bigbud/agent/bin/current"
socket="$HOME/.bigbud/agent/state/supervisor.sock"
test -x "$binary" || { printf 'not-installed\n' >&2; exit 12; }
if test -S "$socket" && "$binary" --prepare-supervisor; then printf awake; exit 0; fi
printf 'not-awake\n' >&2
exit 4"#;

const INSTALL: &str = r#"set -eu
umask 077
version=$1
sha=$2
size=$3
home=$(readlink -f -- "$HOME")
for d in "$home/.bigbud" "$home/.bigbud/agent" "$home/.bigbud/agent/bin" "$home/.bigbud/agent/staging"; do
  test ! -L "$d"
  if test ! -e "$d"; then mkdir -m 700 -- "$d" || test -d "$d"; fi
  test -d "$d"
  test "$(stat -c '%u' -- "$d")" = "$(id -u)"
done
root="$home/.bigbud/agent"
target="$root/bin/$version/$sha"
install -d -m 700 -- "$root/bin/$version"
stage=$(mktemp "$root/staging/.bigbud-remote-agent.XXXXXX")
trap 'rm -f -- "$stage"' EXIT HUP INT TERM
cat > "$stage"
test "$(wc -c < "$stage")" -eq "$size"
test "$(sha256sum "$stage" | awk '{print $1}')" = "$sha"
chmod 700 -- "$stage"
sync -f -- "$stage" 2>/dev/null || true
if ln -- "$stage" "$target" 2>/dev/null; then rm -f -- "$stage"; else
  test -f "$target"
  rm -f -- "$stage"
fi
sync -f -- "$root/bin/$version" 2>/dev/null || true
trap - EXIT HUP INT TERM
printf installed"#;

const REMOVE: &str = r#"set -eu
home=$(readlink -f -- "$HOME")
root="$home/.bigbud/agent"
test ! -L "$root" || { printf 'unsafe-root\n' >&2; exit 13; }
if test -e "$root"; then rm -rf -- "$root"; fi
printf removed"#;

pub(super) fn execute(
    transport: &Transport,
    action: ActionKind,
    artifact: Option<&Artifact<'_>>,
) -> Result<RecipeOutput, ErrorCode> {
    match action {
        ActionKind::PlatformProbe => {
            transport.run_owner_recipe(PLATFORM_PROBE, &[], PLATFORM_TIMEOUT, PLATFORM_LIMIT, None)
        }
        ActionKind::Status => {
            transport.run_owner_recipe(STATUS, &[], STATUS_TIMEOUT, STATUS_LIMIT, None)
        }
        ActionKind::Start => {
            transport.run_owner_recipe(START, &[], CONTROL_TIMEOUT, CONTROL_LIMIT, None)
        }
        ActionKind::Stop => {
            transport.run_owner_recipe(STOP, &[], CONTROL_TIMEOUT, CONTROL_LIMIT, None)
        }
        ActionKind::Wake => {
            transport.run_owner_recipe(WAKE, &[], CONTROL_TIMEOUT, CONTROL_LIMIT, None)
        }
        ActionKind::Install | ActionKind::Update => {
            let artifact = artifact.ok_or(ErrorCode::InvalidOperands)?;
            transport.run_owner_recipe(
                INSTALL,
                &[
                    artifact.version,
                    artifact.sha256,
                    &artifact.size.to_string(),
                ],
                INSTALL_TIMEOUT,
                INSTALL_LIMIT,
                Some(artifact.bytes),
            )
        }
        ActionKind::Remove => {
            transport.run_owner_recipe(REMOVE, &[], INSTALL_TIMEOUT, INSTALL_LIMIT, None)
        }
        ActionKind::Unspecified => Err(ErrorCode::InvalidOperands),
    }
}
