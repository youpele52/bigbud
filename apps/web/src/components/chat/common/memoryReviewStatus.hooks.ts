import type { OrchestrationThreadActivity } from "@bigbud/contracts";
import { useEffect, useMemo, useState } from "react";

import { isWsReconnecting, useWsConnectionStatus } from "~/rpc/wsConnectionState";

import { deriveMemoryReviewAttempt } from "./memoryReviewStatus.logic";

export function useMemoryReviewStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): boolean {
  const [now, setNow] = useState(() => Date.now());
  const attempt = useMemo(() => deriveMemoryReviewAttempt(activities, now), [activities, now]);
  const connection = useWsConnectionStatus();

  useEffect(() => {
    if (!attempt) return;
    const remaining = Date.parse(attempt.expiresAt) - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [attempt]);

  return attempt !== null && connection.phase === "connected" && !isWsReconnecting(connection);
}
