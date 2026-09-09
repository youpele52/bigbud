import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A recovery proxy must never prepare, replace, or restart the runtime it is recovering. */
export function buildPinnedRemoteAgentProxy(runtime: RemoteAgentRuntime): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  return `BIGBUD_AGENT_STATE_DIR=${quote(descriptor.statePath)} exec ${quote(descriptor.binaryPath)} --proxy`;
}

/** Reserve a clean managed runtime before spawning its supervisor. */
export function buildIsolatedRemoteAgentLaunch(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  if (descriptor.origin !== "managed") throw new Error("Legacy runtime launch is not authorized.");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(attemptId)) throw new Error("Invalid launch attempt.");
  return `set -eu
umask 077
state=${quote(descriptor.statePath)}
binary=${quote(descriptor.binaryPath)}
test "$(readlink -m -- "$state")" = "$state"
private_dir() {
  test ! -L "$1"
  if test ! -e "$1"; then mkdir -m 700 -- "$1"; fi
  test -d "$1"
  test "$(stat -c '%u' -- "$1")" = "$(id -u)"
  test "$(stat -c '%a' -- "$1")" = 700
}
private_file() {
  test ! -L "$1"
  test -f "$1"
  test "$(stat -c '%u' -- "$1")" = "$(id -u)"
  test "$(stat -c '%a' -- "$1")" = 600
  test "$(stat -c '%h' -- "$1")" = 1
}
private_dir "$(dirname -- "$state")"
private_dir "$state"
test "$(readlink -f -- "$state")" = "$state"
lock="$state/launch.lock"
if test ! -e "$lock" && test ! -L "$lock"; then (set -C; : > "$lock") 2>/dev/null || test -f "$lock"; fi
private_file "$lock"
exec 8<> "$lock"
if ! flock -n -x 8; then printf launch-in-progress; exit 0; fi
intent="$state/launch.intent"
if test -e "$intent" || test -L "$intent"; then private_file "$intent"; printf launch-uncertain; exit 0; fi
test ! -e "$state/epoch"; test ! -L "$state/epoch"
test ! -e "$state/operations.journal"; test ! -L "$state/operations.journal"
test ! -e "$state/supervisor.sock"; test ! -L "$state/supervisor.sock"
test ! -L "$binary"; test -f "$binary"; test "$(readlink -f -- "$binary")" = "$binary"
test "$(stat -c '%u' -- "$binary")" = "$(id -u)"; test "$(stat -c '%a' -- "$binary")" = 700
test "$(sha256sum -- "$binary" | cut -d ' ' -f1)" = '${descriptor.sha256}'
sync -f "$state"
temporary=$(mktemp "$state/.launch.XXXXXX"); trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
printf '%s' '${attemptId}' > "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$intent"; sync -f "$state"
log=${quote(descriptor.logPath)}
if test -e "$log" || test -L "$log"; then private_file "$log"; fi
BIGBUD_AGENT_STATE_DIR="$state" nohup sh -c '
  "$1" --supervisor
  status=$?
  result=$(mktemp "$BIGBUD_AGENT_STATE_DIR/.launch-exit.XXXXXX") || exit 1
  printf "%s" "$status" > "$result"; sync -f "$result"
  mv -T -- "$result" "$BIGBUD_AGENT_STATE_DIR/launch.exit"; sync -f "$BIGBUD_AGENT_STATE_DIR"
  exit "$status"
' sh "$binary" </dev/null >/dev/null 2>>"$log" &
printf launch-reserved
`;
}

/** Relaunch an existing managed runtime only after its old epoch has died. */
export function buildManagedRemoteAgentReplacementLaunch(
  runtime: RemoteAgentRuntime,
  attemptId: string,
  oldEpoch: string,
): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  if (descriptor.origin !== "managed") throw new Error("Legacy runtime launch is not authorized.");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(attemptId) || !/^[\x21-\x7e]+$/.test(oldEpoch))
    throw new Error("Invalid restart identity.");
  return `set -eu
state=${quote(descriptor.statePath)}; binary=${quote(descriptor.binaryPath)}
test ! -L "$state"; test -d "$state"; test ! -L "$binary"; test -f "$binary"
test "$(sha256sum -- "$binary" | cut -d ' ' -f1)" = '${descriptor.sha256}'
test -f "$state/epoch"; test ! -L "$state/epoch"; test "$(cat "$state/epoch")" = '${oldEpoch}'
test ! -e "$state/supervisor.sock"; test ! -L "$state/supervisor.sock"
test -f "$state/launch.exit"; test ! -L "$state/launch.exit"
if test ! -e "$state/launch.lock" && test ! -L "$state/launch.lock"; then (set -C; : > "$state/launch.lock") 2>/dev/null || test -f "$state/launch.lock"; fi
test ! -L "$state/launch.lock"; exec 8<> "$state/launch.lock"
if ! flock -n -x 8; then printf launch-in-progress; exit 0; fi
rm -f -- "$state/launch.exit"
temporary=$(mktemp "$state/.launch.XXXXXX"); trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
printf '%s' '${attemptId}' > "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$state/launch.intent"; sync -f "$state"
log=${quote(descriptor.logPath)}
if test -e "$log" || test -L "$log"; then test ! -L "$log"; test -f "$log"; fi
BIGBUD_AGENT_STATE_DIR="$state" nohup sh -c '"$1" --supervisor; status=$?; result=$(mktemp "$BIGBUD_AGENT_STATE_DIR/.launch-exit.XXXXXX") || exit 1; printf "%s" "$status" > "$result"; sync -f "$result"; mv -T -- "$result" "$BIGBUD_AGENT_STATE_DIR/launch.exit"; sync -f "$BIGBUD_AGENT_STATE_DIR"; exit "$status"' sh "$binary" </dev/null >/dev/null 2>>"$log" &
printf launch-reserved
`;
}

export function buildRemoteAgentReplacementReadiness(runtime: RemoteAgentRuntime): string {
  const state = quote(runtime.statePath);
  const socket = quote(runtime.socketPath);
  return `set -eu\nstate=${state}; socket=${socket}\nfor n in $(seq 1 300); do\n  if test -S "$socket"; then printf ready; exit 0; fi\n  if test -f "$state/launch.exit" && test ! -L "$state/launch.exit"; then printf 'startup-exit:'; cat "$state/launch.exit"; exit 0; fi\n  sleep .1\ndone\nprintf unavailable\n`;
}

export function buildRemoteAgentReplacementDeathEvidence(runtime: RemoteAgentRuntime): string {
  const state = quote(runtime.statePath);
  const socket = quote(runtime.socketPath);
  return `set -eu\nstate=${state}; socket=${socket}\nfor n in $(seq 1 300); do\n  if test ! -e "$socket" && test ! -L "$socket" && test -f "$state/launch.exit" && test ! -L "$state/launch.exit"; then printf dead; exit 0; fi\n  sleep .1\ndone\nprintf unknown\n`;
}
