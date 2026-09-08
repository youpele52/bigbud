import type {
  RemoteAgentCancelResponse,
  RemoteAgentProcessCompleted,
  RemoteAgentPtyExited,
} from "./remoteAgentProtocol.ts";

export type RemoteAgentTerminalEvidence =
  | "verified-terminal"
  | "cancellation-requested"
  | "outcome-unknown"
  | "control-rejected";

export function remoteAgentProcessTerminalEvidence(
  completed: RemoteAgentProcessCompleted,
): RemoteAgentTerminalEvidence {
  if (
    completed.state === "expired" ||
    ["AGENT_RESTARTED", "OPERATION_EXPIRED", "PROCESS_OUTCOME_UNKNOWN"].includes(
      completed.errorCode,
    )
  )
    return "outcome-unknown";
  return ["completed", "cancelled", "failed"].includes(completed.state)
    ? "verified-terminal"
    : "outcome-unknown";
}

export function remoteAgentPtyTerminalEvidence(
  exited: RemoteAgentPtyExited,
): RemoteAgentTerminalEvidence {
  return exited.hasExitCode || exited.hasSignal ? "verified-terminal" : "outcome-unknown";
}

/** Legacy reports missing history as terminal; only positive evidence releases ownership. */
export function remoteAgentCancelEvidence(
  response: RemoteAgentCancelResponse,
): RemoteAgentTerminalEvidence {
  if (response.detail === "operation-unknown-or-expired") return "outcome-unknown";
  if (
    response.terminal &&
    (response.detail === "operation-already-terminal" ||
      response.detail === "cancellation-terminal")
  )
    return "verified-terminal";
  if (response.cancelled && !response.terminal && response.detail === "cancellation-requested") {
    return "cancellation-requested";
  }
  return "control-rejected";
}
