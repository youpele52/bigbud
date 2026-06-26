import type { OrchestrationThread, ThreadId } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";

import { useMobileRpcClient } from "../context/MobileRpcContext";

function formatQueryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Failed to load the desktop thread.";
}

export function useMobileThread(session: { sessionId: string } | null, threadId: ThreadId) {
  const { client } = useMobileRpcClient();

  const threadQuery = useQuery<OrchestrationThread>({
    enabled: client !== null && session !== null,
    queryKey: ["mobile-thread", session?.sessionId ?? "anonymous", threadId],
    queryFn: () => client!.getMobileThread(threadId),
    retry: 1,
    retryDelay: (attempt) => Math.min(750 * 2 ** attempt, 8_000),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  return {
    threadQuery,
    threadError: threadQuery.isError ? formatQueryError(threadQuery.error) : null,
  };
}
