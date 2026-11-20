import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import {
  quoteRemoteAgentLaunchValue as quote,
  REMOTE_AGENT_SUPERVISOR_LOG_ROTATE_BYTES,
} from "./remoteAgentRuntime.launch.prepare.ts";

/** Relaunch an existing managed runtime only after its old epoch has died. */
export function buildManagedRemoteAgentReplacementPreparation(
  runtime: RemoteAgentRuntime,
  attemptId: string,
  oldEpoch: string,
  oldAttemptId: string,
): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  if (descriptor.origin !== "managed") throw new Error("Legacy runtime launch is not authorized.");
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(attemptId) || !/^[\x21-\x7e]+$/.test(oldEpoch))
    throw new Error("Invalid restart identity.");
  return `set -eu
umask 077
${buildRemoteAgentSupervisorObservation(descriptor, oldAttemptId, true)}
binary=${quote(descriptor.binaryPath)}
test ! -L "$state"; test -d "$state"; test ! -L "$binary"; test -f "$binary"
test "$(sha256sum -- "$binary" | cut -d ' ' -f1)" = '${descriptor.sha256}'
test -f "$state/epoch"; test ! -L "$state/epoch"
test "$(stat -c '%u' -- "$state/epoch")" = "$(id -u)"
test "$(wc -c < "$state/epoch")" -le 256
test "$(cat "$state/epoch")" = ${quote(oldEpoch)}
private_file "$state/launch.lock"; exec 8<> "$state/launch.lock"
lock_status=0; flock -n -x -E 75 8 || lock_status=$?
if test "$lock_status" = 75; then printf launch-in-progress; exit 0; fi
test "$lock_status" = 0
case "$(observe_supervisor)" in exited:*|prior-boot-dead) ;; *) printf launch-uncertain; exit 0 ;; esac
if test -e "$socket" || test -L "$socket"; then
  test -S "$socket"; test ! -L "$socket"
  test "$(stat -c '%u' -- "$socket")" = "$(id -u)"
  rm -- "$socket"
fi
record_launch_boot
rm -f -- "$state/launch.exit"
temporary=$(mktemp "$state/.launch.XXXXXX"); trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
printf '%s' '${attemptId}' > "$temporary"; sync -f "$temporary"; mv -T -- "$temporary" "$state/launch.intent"; sync -f "$state"
log=${quote(descriptor.logPath)}
if test -e "$log" || test -L "$log"; then test ! -L "$log"; test -f "$log"; fi
if test -f "$log" && test "$(wc -c < "$log")" -gt ${REMOTE_AGENT_SUPERVISOR_LOG_ROTATE_BYTES}; then mv -f -- "$log" "$log.1"; fi
`;
}
