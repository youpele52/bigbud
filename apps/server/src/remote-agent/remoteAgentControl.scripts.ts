import { quoteShellArgument as quote } from "./remoteAgentShellQuote.ts";
import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/**
 * Control scripts that used to be written inline at their call sites. They are
 * named builders now so that the legacy runner and the owner template generator
 * (`remoteAgentControl.templates.ts`) compile the same text. Each body is moved
 * verbatim; behaviour is unchanged.
 */

/** Resolve the verified account's canonical control root without opening any agent state. */
export const REMOTE_AGENT_CONTROL_ROOT_SCRIPT = `set -eu
umask 077
home=$(readlink -f -- "$HOME")
for path in "$home/.bigbud" "$home/.bigbud/agent"; do
  test ! -L "$path"
  if test ! -e "$path"; then mkdir -m 700 -- "$path" || test -d "$path"; fi
  test -d "$path"
  test "$(stat -c '%u' -- "$path")" = "$(id -u)"
  mode=$(stat -c '%a' -- "$path")
  if test "$path" = "$home/.bigbud"; then
    test "$mode" = 700 || test "$mode" = 755
  else
    test "$mode" = 700
  fi
done
printf '%s' "$home/.bigbud/agent"
`;

/** The host's own clock; removal fences are timed by it. */
export const REMOTE_AGENT_HOST_CLOCK_SCRIPT = "date +%s";

/** A runtime without a recorded launch: is its state directory provably absent? */
export function buildRemoteAgentStateAbsentProbe(statePath: string): string {
  return `set -eu
state=${quote(statePath)}
if test ! -e "$state" && test ! -L "$state" && test "$(readlink -m -- "$state")" = "$state"; then printf absent; else printf uncertain; fi
`;
}

/** Retirement: map one observation to live, dead or uncertain. */
export function buildRemoteAgentSupervisorStateProbe(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
case "$(observe_supervisor)" in
  ready|live) printf live ;;
  exited:*) printf dead ;;
  prior-boot-dead) printf dead ;;
  *) printf uncertain ;;
esac
`;
}

/** Retirement: wait, bounded, for the recorded launch to exit. */
export function buildRemoteAgentSupervisorExitAwait(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
for n in $(seq 1 100); do
  case "$(observe_supervisor)" in exited:*|prior-boot-dead) printf exited; exit 0 ;; esac
  sleep .1
done
printf uncertain
`;
}

/** Launch reconciliation: dead, prior-boot-dead or unknown. */
export function buildRemoteAgentLaunchExitObservation(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
case "$(observe_supervisor)" in
  exited:*) printf dead ;;
  prior-boot-dead) printf prior-boot-dead ;;
  *) printf unknown ;;
esac
`;
}

/** Restart: the raw observation of the previous launch. */
export function buildRemoteAgentRawSupervisorObservation(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
observe_supervisor
`;
}

/** Failed admission: death observation bound to the recorded epoch. No launch, stop or replay. */
export function buildRemoteAgentAdmissionDeathObservation(
  runtime: RemoteAgentRuntime,
  attemptId: string,
  epoch: string,
): string {
  return `set -eu
# Failed admission death observation: no launch, stop, or replay.
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
test -f "$state/epoch" && test ! -L "$state/epoch" &&
test "$(stat -c '%u' -- "$state/epoch")" = "$(id -u)" &&
# Native AgentState writes owner-only 0700; older private epoch files may be 0600.
{ test "$(stat -c '%a' -- "$state/epoch")" = 600 || test "$(stat -c '%a' -- "$state/epoch")" = 700; } &&
test "$(stat -c '%h' -- "$state/epoch")" = 1 &&
test "$(wc -c < "$state/epoch")" -le 256 &&
test "$(cat "$state/epoch")" = ${quote(epoch)} || { printf unknown; exit 0; }
observe_supervisor
`;
}

/**
 * Shell test: is a process still bound to this socket? Reads `/proc/net/unix`, so a stale socket
 * file left by a crashed supervisor is not mistaken for a live one.
 */
export function buildRemoteAgentSocketLivenessCheck(socketPath: string): string {
  return `awk -v p=${quote(socketPath)} 'NR > 1 && $NF == p { found = 1 } END { exit found ? 0 : 1 }' /proc/net/unix`;
}

export function buildRemoteAgentSocketLiveProbe(socketPath: string): string {
  return `if test ! -r /proc/net/unix; then printf socket; elif ${buildRemoteAgentSocketLivenessCheck(socketPath)}; then printf socket; else printf none; fi`;
}

export function buildRemoteAgentSocketGoneWait(socketPath: string): string {
  return `set -eu
for n in $(seq 1 100); do
  if ! ${buildRemoteAgentSocketLivenessCheck(socketPath)}; then printf exited; exit 0; fi
  sleep .1
done
printf uncertain
`;
}
