import { resolveExecutionTargetId, type ExecutionTargetId } from "@bigbud/contracts";
import { useQuery } from "@tanstack/react-query";

import { useMobileRpcClient } from "../context/MobileRpcContext";

const GIT_STATUS_STALE_TIME_MS = 5_000;

export function useMobileGitStatus(
  cwd: string | null | undefined,
  executionTargetId: ExecutionTargetId | null | undefined,
) {
  const { client } = useMobileRpcClient();
  const resolvedExecutionTargetId = resolveExecutionTargetId(executionTargetId);

  return useQuery({
    enabled: client !== null && typeof cwd === "string" && cwd.length > 0,
    queryKey: ["mobile-git-status", resolvedExecutionTargetId, cwd ?? null] as const,
    queryFn: () =>
      client!.refreshGitStatus({
        cwd: cwd!,
        executionTargetId: resolvedExecutionTargetId,
      }),
    staleTime: GIT_STATUS_STALE_TIME_MS,
    retry: 1,
  });
}
