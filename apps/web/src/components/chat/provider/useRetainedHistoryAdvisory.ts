import { useSyncExternalStore } from "react";
import { retainedHistoryAdvisoryState } from "./ProviderStatusBanner.advisory.state";

/** Share dismissal across mounted chats, including when browser storage cannot be written. */
export function useRetainedHistoryAdvisory() {
  return useSyncExternalStore(
    retainedHistoryAdvisoryState.subscribe,
    retainedHistoryAdvisoryState.getSnapshot,
    () => false,
  );
}
