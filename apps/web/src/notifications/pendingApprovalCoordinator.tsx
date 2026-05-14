import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@bigbud/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { PendingApprovalDialog } from "../components/chat/composer/PendingApprovalDialog";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import { collectGlobalPendingApprovalCandidate } from "./pendingApprovalCoordinator.logic";

export function PendingApprovalCoordinator() {
  const threads = useStore((state) => state.threads);
  const projects = useStore((state) => state.projects);
  const setStoreThreadError = useStore((state) => state.setError);
  const candidate = collectGlobalPendingApprovalCandidate(threads, projects);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const lastRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const requestId = candidate?.approval.requestId ?? null;
    if (!requestId) {
      setDialogOpen(false);
      lastRequestIdRef.current = null;
      return;
    }
    if (lastRequestIdRef.current !== requestId) {
      lastRequestIdRef.current = requestId;
      setDialogOpen(true);
    }
  }, [candidate?.approval.requestId]);

  const onRespondToApproval = useCallback(
    async (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) {
        return;
      }

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            threadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [setStoreThreadError],
  );

  if (!candidate) {
    return null;
  }

  const activeRequestId = candidate.approval.requestId;
  const isResponding = respondingRequestIds.includes(activeRequestId);
  const threadPath = `/${candidate.threadId}`;
  const openThread =
    pathname === threadPath
      ? undefined
      : () => {
          void navigate({ to: "/$threadId", params: { threadId: candidate.threadId } });
        };

  return (
    <PendingApprovalDialog
      approval={candidate.approval}
      pendingCount={candidate.pendingCount}
      open={dialogOpen}
      isResponding={isResponding}
      projectName={candidate.projectName}
      threadTitle={candidate.threadTitle}
      workingDirectory={candidate.workingDirectory}
      onOpenThread={openThread}
      onOpenChange={setDialogOpen}
      onRespondToApproval={(requestId, decision) =>
        onRespondToApproval(candidate.threadId, requestId, decision)
      }
    />
  );
}
