import type { RemoteAgentProcessCompleted } from "./remoteAgentProtocol.ts";

/**
 * Attaching behind the agent's retained output window still returns the
 * verified terminal result; only some output was lost. The result is marked
 * truncated so consumers never treat partial output as complete.
 */
export function markRemoteAgentReplayGap(
  completed: RemoteAgentProcessCompleted,
): RemoteAgentProcessCompleted {
  return { ...completed, outputTruncated: true };
}

/** User-facing summary: "finished with exit N, output partly lost". */
export function describeRemoteAgentProcessReplayGap(
  completed: Pick<RemoteAgentProcessCompleted, "hasExitCode" | "exitCode" | "state">,
): string {
  return completed.hasExitCode
    ? `finished with exit ${completed.exitCode}, output partly lost`
    : `finished (${completed.state}), output partly lost`;
}
