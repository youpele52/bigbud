import { useEffect } from "react";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { OPENCODE_RETAINED_HISTORY_ADVISORY } from "@bigbud/shared/opencodeAdvisory";
import { toastManager } from "./ui/toast";
import { getRetainedHistoryAdvisory } from "./chat/provider/ProviderStatusBanner.advisory";
import { retainedHistoryAdvisoryState } from "./chat/provider/ProviderStatusBanner.advisory.state";
import { useRetainedHistoryAdvisory } from "./chat/provider/useRetainedHistoryAdvisory";

/** A previously dismissed advisory gets one amber reminder on the next app runtime, not on close. */
export function useOpencodeRetainedHistoryToast(providers: ReadonlyArray<ServerProvider>) {
  const dismissed = useRetainedHistoryAdvisory();
  useEffect(() => {
    const present = providers.some(
      (provider) => provider.enabled && getRetainedHistoryAdvisory(provider)?.advisoryOnly,
    );
    if (!dismissed || !present || !retainedHistoryAdvisoryState.claimStartupToast()) return;
    toastManager.add({
      type: "warning",
      title: "OpenCode native history retained",
      description: OPENCODE_RETAINED_HISTORY_ADVISORY,
      data: { hideCopyButton: true },
    });
  }, [dismissed, providers]);
}
