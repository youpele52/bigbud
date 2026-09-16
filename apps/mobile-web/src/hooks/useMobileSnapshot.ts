import type { OrchestrationReadModel } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";

import { useMobileRpcClient } from "../context/MobileRpcContext";
import type { MobileConnectionState } from "../logic/mobileConnection.logic";
import { describeRecoveryReason } from "../logic/mobileRecovery.types";

function formatQueryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to connect to the desktop server.";
}

export function useMobileSnapshot(session: { sessionId: string } | null) {
  const { client, connection, recovery, recoveryState, restart } = useMobileRpcClient();

  const snapshotQuery = useQuery<OrchestrationReadModel>({
    enabled: recoveryState.freshness === "legacy",
    queryKey: ["mobile-snapshot", session?.sessionId ?? "anonymous"],
    queryFn: () => client!.getSnapshot(),
    retry: recovery === null ? 1 : false,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 8_000),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const connectionError = describeConnectionError(
    connection,
    snapshotQuery.error,
    snapshotQuery.isError,
  );

  return {
    client,
    connection,
    restart,
    recovery,
    recoveryState,
    snapshotQuery: recovery
      ? {
          ...snapshotQuery,
          refetch: async () => {
            await recovery.refresh();
            return snapshotQuery;
          },
        }
      : snapshotQuery,
    connectionError:
      connectionError ??
      (recoveryState.reason !== null && recoveryState.freshness !== "legacy"
        ? describeRecoveryReason(recoveryState.reason)
        : null),
  };
}

function describeConnectionError(
  connection: MobileConnectionState,
  error: unknown,
  hasQueryError: boolean,
): string | null {
  if (connection.authorization === "locally-expired") {
    return "This mobile session has expired. Open a new pairing link from the desktop app.";
  }
  if (connection.authorization === "explicitly-rejected") {
    return "The desktop server rejected this connection. Pair this phone again.";
  }
  if (hasQueryError) return formatQueryError(error);
  if (connection.transport === "exhausted" || connection.transport === "closed") {
    return "Unable to connect to the desktop server.";
  }
  return null;
}
