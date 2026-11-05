import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { useEffect, useRef } from "react";

import { WorkspaceRequestRecovery } from "../lib/workspaceRequestRecovery";

export function useWorkspaceRequestRecovery(
  workspaceIdentity: string,
  executionTargetId?: string | null,
) {
  const identity = JSON.stringify([workspaceIdentity, executionTargetId]);
  const current = useRef<{ identity: string; recovery: WorkspaceRequestRecovery } | null>(null);
  if (current.current?.identity !== identity) {
    current.current = {
      identity,
      recovery: new WorkspaceRequestRecovery(isRemoteExecutionTargetId(executionTargetId)),
    };
  }
  const { recovery } = current.current;
  const mounted = useRef(new Set<WorkspaceRequestRecovery>());
  useEffect(() => {
    recovery.resume();
    const active = mounted.current;
    active.add(recovery);
    return () => {
      active.delete(recovery);
      // StrictMode immediately sets up the same resource again. Do not reject its live query.
      queueMicrotask(() => {
        if (!active.has(recovery)) recovery.dispose();
      });
    };
  }, [recovery]);
  return recovery;
}
