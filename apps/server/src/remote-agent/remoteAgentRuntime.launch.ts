import { buildManagedRemoteAgentReplacementPreparation } from "./remoteAgentRuntime.launch.replacement.ts";
import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import {
  buildRemoteAgentLaunchPreparation,
  quoteRemoteAgentLaunchValue as quote,
  REMOTE_AGENT_SUPERVISOR_LOG_ROTATE_BYTES,
} from "./remoteAgentRuntime.launch.prepare.ts";
export { REMOTE_AGENT_SUPERVISOR_LOG_ROTATE_BYTES };
import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/** A recovery proxy must never prepare, replace, or restart the runtime it is recovering. */
export function buildPinnedRemoteAgentProxy(runtime: RemoteAgentRuntime): string {
  const descriptor = validateRemoteAgentRuntime(runtime);
  const proxy = `BIGBUD_AGENT_STATE_DIR=${quote(descriptor.statePath)} exec ${quote(descriptor.binaryPath)} --proxy`;
  // External paths are user-controlled, not protected by the managed installer.
  // Refuse changed bytes before running even the proxy; hello also checks build/epoch.
  return descriptor.origin === "legacy-external"
    ? `test "$(sha256sum -- ${quote(descriptor.binaryPath)} | cut -d ' ' -f1)" = '${descriptor.sha256}' && ${proxy}`
    : proxy;
}

/** Default SSH launcher retains the exact P4 preparation and independent nohup path. */
export function buildIsolatedRemoteAgentLaunch(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `${buildRemoteAgentLaunchPreparation(runtime, attemptId)}BIGBUD_AGENT_STATE_DIR="$state" nohup sh -c '
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

/** Default SSH replacement retains the existing preparation and independent nohup path. */
export function buildManagedRemoteAgentReplacementLaunch(
  runtime: RemoteAgentRuntime,
  attemptId: string,
  oldEpoch: string,
  oldAttemptId: string,
): string {
  return `${buildManagedRemoteAgentReplacementPreparation(runtime, attemptId, oldEpoch, oldAttemptId)}BIGBUD_AGENT_STATE_DIR="$state" nohup sh -c '"$1" --supervisor; status=$?; result=$(mktemp "$BIGBUD_AGENT_STATE_DIR/.launch-exit.XXXXXX") || exit 1; printf "%s" "$status" > "$result"; sync -f "$result"; mv -T -- "$result" "$BIGBUD_AGENT_STATE_DIR/launch.exit"; sync -f "$BIGBUD_AGENT_STATE_DIR"; exit "$status"' sh "$binary" </dev/null >/dev/null 2>>"$log" &
printf launch-reserved
`;
}

export function buildRemoteAgentReplacementReadiness(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
for n in $(seq 1 300); do
  observed=$(observe_supervisor)
  case "$observed" in
    ready) printf ready; exit 0 ;;
    exited:*) printf 'startup-exit:%s' "\${observed#exited:}"; exit 0 ;;
    prior-boot-dead) printf prior-boot-dead; exit 0 ;;
  esac
  sleep .1
done
printf unavailable
`;
}

export function buildRemoteAgentReplacementDeathEvidence(
  runtime: RemoteAgentRuntime,
  attemptId: string,
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
for n in $(seq 1 300); do
  case "$(observe_supervisor)" in
    exited:*) printf dead; exit 0 ;;
    prior-boot-dead) printf prior-boot-dead; exit 0 ;;
  esac
  sleep .1
done
printf unknown
`;
}
