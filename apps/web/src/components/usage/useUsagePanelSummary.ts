import type { ServerUsageSummaryResult } from "@bigbud/contracts/server/usage.ts";
import { useEffect, useMemo, useState } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { createUsagePanelPoller } from "./UsagePanel.polling";
import { requestUsagePanelSummary } from "./UsagePanel.request";

export function useUsagePanelSummary(visible: boolean) {
  const api = readNativeApi();
  const [state, setState] = useState<{
    summary: ServerUsageSummaryResult | null;
    loading: boolean;
    error: string | null;
  }>({ summary: null, loading: true, error: null });
  const poller = useMemo(
    () =>
      api
        ? createUsagePanelPoller({
            fetchSummary: (isCurrent) => requestUsagePanelSummary(api.server, isCurrent),
            onStart: () => setState((previous) => ({ ...previous, loading: true })),
            onSuccess: (summary) => setState({ summary, loading: false, error: null }),
            onError: () =>
              setState((previous) => ({
                ...previous,
                loading: false,
                error:
                  "Usage could not be refreshed. It will retry automatically while this panel is open.",
              })),
          })
        : null,
    [api],
  );

  useEffect(() => {
    if (!poller) return;
    const syncVisibility = () =>
      poller.setEnabled(visible && document.visibilityState !== "hidden");
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      poller.setEnabled(false);
    };
  }, [poller, visible]);

  return api ? state : { ...state, loading: false, error: "Usage connection unavailable." };
}
