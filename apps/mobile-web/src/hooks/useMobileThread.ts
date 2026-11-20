import { mobileSessionStateScope } from "../lib/mobileSessionAuthority";
import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useMobileRpcClient } from "../context/MobileRpcContext";

function formatQueryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to load the desktop thread.";
}

export function useMobileThread(session: { sessionId: string } | null, threadId: ThreadId) {
  const { client, recovery } = useMobileRpcClient();
  const sessionId = session ? mobileSessionStateScope(session, "query") : undefined;

  const threadQuery = useQuery<OrchestrationThread>({
    enabled: false,
    queryKey: ["mobile-thread", sessionId ?? "anonymous", threadId],
    queryFn: () => client!.getMobileThread(threadId),
    retry: recovery === null ? 1 : false,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 8_000),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!client || !sessionId || !recovery) return;
    void recovery.selectThread(threadId).catch(() => undefined);
  }, [client, recovery, sessionId, threadId]);

  return {
    threadQuery: recovery
      ? {
          ...threadQuery,
          refetch: async () => {
            await recovery.selectThread(threadId);
            return threadQuery;
          },
        }
      : threadQuery,
    threadError: threadQuery.isError ? formatQueryError(threadQuery.error) : null,
  };
}
