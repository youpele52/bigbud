import type { OrchestrationReadModel } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";

import { useMobileRpcClient } from "../context/MobileRpcContext";
import { describeRecoveryReason } from "../logic/mobileRecovery.types";

function formatQueryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to connect to the desktop server.";
}

export function useMobileSnapshot(session: { sessionId: string } | null) {
  const { client, recovery, recoveryState } = useMobileRpcClient();

  const snapshotQuery = useQuery<OrchestrationReadModel>({
    enabled: false,
    queryKey: ["mobile-snapshot", session?.sessionId ?? "anonymous"],
    queryFn: () => client!.getSnapshot(),
    retry: recovery === null ? 1 : false,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 8_000),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  return {
    client,
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
    connectionError: snapshotQuery.isError
      ? formatQueryError(snapshotQuery.error)
      : recoveryState.reason !== null && recoveryState.freshness !== "legacy"
        ? describeRecoveryReason(recoveryState.reason)
        : null,
  };
}
