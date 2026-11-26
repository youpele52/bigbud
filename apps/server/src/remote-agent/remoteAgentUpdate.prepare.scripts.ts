import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/** The deterministic launch attempt id of a staged candidate runtime. */
export function launchAttemptId(runtime: RemoteAgentRuntime): string {
  return `launch-${runtime.generation}`;
}

export function buildRemoteAgentCandidateStartupWaitCommand(
  runtime: RemoteAgentRuntime,
  attemptId = launchAttemptId(runtime),
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
for n in $(seq 1 300); do
  observed=$(observe_supervisor)
  case "$observed" in
    ready) printf ready; exit 0 ;;
    prior-boot-dead) printf prior-boot-dead; exit 0 ;;
    exited:*) printf 'startup-exit:%s' "\${observed#exited:}"; exit 0 ;;
  esac
  sleep .1
done
printf unavailable
`;
}

export function buildRemoteAgentCandidateExitWaitCommand(
  runtime: RemoteAgentRuntime,
  attemptId = launchAttemptId(runtime),
): string {
  return `set -eu
${buildRemoteAgentSupervisorObservation(runtime, attemptId)}
for n in $(seq 1 300); do
  case "$(observe_supervisor)" in
    exited:*) printf exited; exit 0 ;;
    prior-boot-dead) printf prior-boot-dead; exit 0 ;;
  esac
  sleep .1
done
printf unavailable
`;
}
