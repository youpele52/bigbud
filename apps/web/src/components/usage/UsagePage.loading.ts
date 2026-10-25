import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import type { ServerUsageRange, ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";
import { useEffect, useState } from "react";

import { retryTransportRecoveryOperation } from "~/logic/orchestration/transport-retry.logic";
import { readNativeApi } from "~/rpc/nativeApi";
import { toastManager } from "../ui/toast";

/** Retained provider allowances are usable before the independent usage summary arrives. */
export function hasUsagePageLimits(limits: ReadonlyArray<ServerProviderUsageLimits | undefined>) {
  return limits.some((limit) => limit?.status === "available" || limit?.status === "stale");
}

/** Refresh in place and ignore completions belonging to an obsolete range or unmounted page. */
export function useUsagePageSummary(range: ServerUsageRange) {
  const api = readNativeApi();
  const [summary, setSummary] = useState<ServerUsageSummaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    setLoading(true);
    setError(null);
    void retryTransportRecoveryOperation(() => api.server.getUsageSummary({ range }), {
      maxRetries: 2,
      shouldAbort: () => !active,
    })
      .then((next) => {
        if (active) setSummary(next);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const description = cause instanceof Error ? cause.message : "An error occurred.";
        setError(description);
        toastManager.add({ type: "error", title: "Failed to load usage", description });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, range]);

  return api
    ? { summary, loading, error }
    : { summary, loading: false, error: "Usage connection unavailable." };
}
