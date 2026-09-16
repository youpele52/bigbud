import type {
  ServerConnectRemoteAgentResult,
  ServerRemoteAgentRuntimeSummary,
} from "@bigbud/contracts/server/server.ts";
import { toastManager } from "../ui/toast.manager";

const notifiedConnections = new Set<string>();
const MAX_NOTIFIED_CONNECTIONS = 256;

function fallbackReason(failureCode: string | undefined): string {
  switch (failureCode) {
    case "NOT_READY":
      return "The updated agent did not confirm it was ready.";
    case "UNREACHABLE":
      return "The updated agent could not be reached.";
    case "INCOMPATIBLE_PROTOCOL":
    case "INCOMPATIBLE_CAPABILITY":
      return "The updated agent is not compatible with this connection.";
    case "IDENTITY_MISMATCH":
    case "INVALID_HELLO":
      return "The updated agent could not be verified.";
    default:
      return "The agent update could not be used for this connection.";
  }
}

export function remoteAgentConnectionWarning(
  result: ServerRemoteAgentRuntimeSummary,
): string | undefined {
  if (!result.warning && result.outcome !== "fallback") return undefined;
  const version = result.currentVersion ?? "(version unavailable)";
  const connection =
    result.requestedVersion && result.requestedVersion !== result.currentVersion
      ? `Could not use agent ${result.requestedVersion}. Connected using healthy agent ${version}.`
      : `Connected using existing agent ${version}.`;
  return `${connection} ${result.warning ?? fallbackReason(result.failureCode)}`;
}

/** Only successful explicit connects notify; observing a retained runtime never does. */
export function notifyRemoteAgentConnection(
  executionTargetId: string,
  result: ServerConnectRemoteAgentResult,
): void {
  const description = remoteAgentConnectionWarning(result);
  if (!description) return;
  const key = JSON.stringify([executionTargetId, result.connectionId]);
  if (notifiedConnections.has(key)) return;
  notifiedConnections.add(key);
  if (notifiedConnections.size > MAX_NOTIFIED_CONNECTIONS)
    notifiedConnections.delete(notifiedConnections.values().next().value!);
  toastManager.add({
    type: "warning",
    title: "Remote agent update unavailable",
    description,
  });
}
