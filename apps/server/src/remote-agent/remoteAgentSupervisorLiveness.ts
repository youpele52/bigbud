import { remoteAgentBootEvidenceFunctions } from "./remoteAgentBootEvidence.ts";
import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Bounded observation of the expected launch. Socket files alone never prove readiness. */
export function buildRemoteAgentSupervisorObservation(
  runtime: RemoteAgentRuntime,
  attemptId: string,
  lockAlreadyHeld = false,
): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(attemptId)) throw new Error("Invalid launch attempt.");
  return `state=${quote(descriptor.statePath)}
socket=${quote(descriptor.socketPath)}
private_file() {
  test -f "$1" && test ! -L "$1" &&
    test "$(stat -c '%u' -- "$1")" = "$(id -u)" &&
    test "$(stat -c '%a' -- "$1")" = 600 &&
    test "$(stat -c '%h' -- "$1")" = 1 &&
    test "$(wc -c < "$1")" -le 64
}
${remoteAgentBootEvidenceFunctions()}
observe_supervisor() (
  test -d "$state" && test ! -L "$state" &&
    test "$(readlink -f -- "$state")" = "$state" &&
    test "$(stat -c '%u' -- "$state")" = "$(id -u)" &&
    test "$(stat -c '%a' -- "$state")" = 700 || { printf unknown; exit 0; }
  private_file "$state/launch.lock" && private_file "$state/launch.intent" || { printf unknown; exit 0; }
  lock_status=0
${
  lockAlreadyHeld
    ? "  # Caller holds the validated launch lock across observation and replacement."
    : `  exec 8< "$state/launch.lock"
  flock -n -x -E 75 8 || lock_status=$?`
}
  test "$(cat "$state/launch.intent")" = ${quote(attemptId)} || { printf unknown; exit 0; }
  if test "$lock_status" = 75; then
    if test "$(boot_relation)" = current && test -S "$socket" && test ! -L "$socket" &&
      test ! -e "$state/launch.exit" && test ! -L "$state/launch.exit"; then printf ready;
    else printf live; fi
  elif test "$lock_status" = 0 && private_file "$state/launch.exit"; then
    receipt=$(cat "$state/launch.exit")
    case "$receipt" in
      [0-9]|[0-9][0-9]|[0-9][0-9][0-9]) printf 'exited:%s' "$receipt" ;;
      *) printf unknown ;;
    esac
  elif test "$lock_status" = 0 && test "$(boot_relation)" = previous; then
    printf prior-boot-dead
  else printf unknown; fi
)
`;
}
