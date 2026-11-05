import { useEffect, useState } from "react";
import {
  type MonitorState,
  useResourceMonitorStore,
} from "~/stores/resource-monitor/resourceMonitor.store";
import { currentAppResources } from "./BigbudResourceView.logic";
type LocalMonitorScope = "system" | "bigbud";

function hasPageData(state: MonitorState, scope: LocalMonitorScope): boolean {
  const { snapshot } = state;
  if (scope === "bigbud") {
    const current =
      state.connection === "connected" &&
      !state.appReason &&
      (!state.collectionStatus || state.collectionStatus.state === "healthy");
    return (
      Boolean(currentAppResources(snapshot, current)) ||
      Boolean(
        current &&
        snapshot?.summaryStatus === "ready" &&
        snapshot.memoryTotalBytes?.status === "ready" &&
        Number.isFinite(snapshot.memoryTotalBytes.value),
      )
    );
  }
  return snapshot !== null;
}

/** Gate only initial collection; later gaps keep diagnostics visible without exposing stale totals. */
export function useSystemMonitorPageLoading(scope: LocalMonitorScope): boolean {
  const hasData = useResourceMonitorStore((state) => hasPageData(state, scope));
  const failed = useResourceMonitorStore(
    (state) =>
      state.connection === "unavailable" ||
      state.collectionStatus?.state === "failed" ||
      (scope === "bigbud" && Boolean(state.appReason)),
  );
  const [revealed, setRevealed] = useState({ system: false, bigbud: false });
  useEffect(() => {
    if (hasData)
      setRevealed((previous) => (previous[scope] ? previous : { ...previous, [scope]: true }));
  }, [hasData, scope]);
  return !hasData && !revealed[scope] && !failed;
}
