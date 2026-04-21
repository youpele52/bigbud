import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useStore } from "../stores/main";
import { collectLatestPendingApprovalCandidate } from "./pendingApprovalNavigation.logic";

export function PendingApprovalNavigation() {
  const threads = useStore((state) => state.threads);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const lastHandledRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const candidate = collectLatestPendingApprovalCandidate(threads);
    if (!candidate) {
      lastHandledRequestIdRef.current = null;
      return;
    }
    const requestId = candidate.approval.requestId;
    if (lastHandledRequestIdRef.current === requestId) {
      return;
    }

    lastHandledRequestIdRef.current = requestId;

    const threadPath = `/${candidate.threadId}`;
    if (pathname === threadPath) {
      return;
    }

    void navigate({ to: "/$threadId", params: { threadId: candidate.threadId } });
  }, [navigate, pathname, threads]);

  return null;
}
