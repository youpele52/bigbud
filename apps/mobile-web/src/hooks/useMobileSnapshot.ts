import type { OrchestrationReadModel } from "@bigbud/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useMobileRpcClient } from "../context/MobileRpcContext";

function formatQueryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to connect to the desktop server.";
}

export function useMobileSnapshot(session: { sessionId: string } | null) {
  const queryClient = useQueryClient();
  const { client } = useMobileRpcClient();

  const snapshotQuery = useQuery<OrchestrationReadModel>({
    enabled: client !== null && session !== null,
    queryKey: ["mobile-snapshot", session?.sessionId ?? "anonymous"],
    queryFn: () => client!.getSnapshot(),
    retry: 1,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 8_000),
    staleTime: 1_000,
  });

  useEffect(() => {
    if (!client || !session || !snapshotQuery.isSuccess) {
      return;
    }
    const unsubscribe = client.onDomainEvent(() => {
      void queryClient.invalidateQueries({ queryKey: ["mobile-snapshot", session.sessionId] });
    });
    return unsubscribe;
  }, [client, queryClient, session, snapshotQuery.isSuccess]);

  return {
    client,
    snapshotQuery,
    connectionError: snapshotQuery.isError ? formatQueryError(snapshotQuery.error) : null,
  };
}
