import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useWorkspaceRequestRecovery } from "../../hooks/useWorkspaceRequestRecovery";
import { projectSearchEntriesQueryOptions } from "../../lib/projectReactQuery";

export function useWorkspaceFileSearch(input: {
  readonly cwd: string | null;
  readonly executionTargetId?: ExecutionTargetId | null | undefined;
  readonly query: string;
  readonly enabled: boolean;
  readonly limit: number;
}) {
  const identity = JSON.stringify([
    input.cwd,
    input.executionTargetId,
    input.query,
    input.enabled,
    input.limit,
  ]);
  const recovery = useWorkspaceRequestRecovery(identity, input.executionTargetId);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState({ identity, recovering: false, pending: false });
  const options = projectSearchEntriesQueryOptions(input);
  const query = useQuery({
    ...options,
    retry: false,
    placeholderData: () => undefined,
    queryFn: (context) => {
      const fetchEntries = options.queryFn;
      if (typeof fetchEntries !== "function") throw new Error("Workspace search unavailable.");
      return recovery.execute("search", () => Promise.resolve(fetchEntries(context)), {
        onRecovering: () => setStatus({ identity, recovering: true, pending: true }),
        onSuccess: (result) => {
          setStatus({ identity, recovering: false, pending: false });
          // A timed-out RPC may still complete; its result belongs only to this cache key.
          queryClient.setQueryData(options.queryKey, result);
        },
        onError: (_error, pending) => setStatus({ identity, recovering: false, pending }),
      });
    },
  });
  return {
    ...query,
    recovering: status.identity === identity && status.recovering,
    requestPending: status.identity === identity && status.pending,
  };
}
