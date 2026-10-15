import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@bigbud/contracts";
import { CircleAlertIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { StatusBanner } from "../../common/StatusBanner";
import {
  getRetainedHistoryAdvisory,
  withoutDismissedRetainedHistoryAdvisory,
} from "./ProviderStatusBanner.advisory";
import { retainedHistoryAdvisoryState } from "./ProviderStatusBanner.advisory.state";
import { useRetainedHistoryAdvisory } from "./useRetainedHistoryAdvisory";
import { withoutVerifiedRuntimeNotice } from "./ProviderStatusBanner.qualification";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
  runtimeVerified = false,
}: {
  status: ServerProvider | null;
  runtimeVerified?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const prevKeyRef = useRef<string | null>(null);
  const advisoryDismissed = useRetainedHistoryAdvisory();
  const visibleStatus = withoutDismissedRetainedHistoryAdvisory(
    withoutVerifiedRuntimeNotice(status, runtimeVerified),
    advisoryDismissed,
  );

  // Re-show banner when the provider or its message changes
  const key = status ? `${status.provider}:${status.status}:${status.message ?? ""}` : null;
  useEffect(() => {
    if (key && key !== prevKeyRef.current) {
      setDismissed(false);
      prevKeyRef.current = key;
    }
  }, [key]);

  if (
    !visibleStatus ||
    visibleStatus.status === "ready" ||
    visibleStatus.status === "disabled" ||
    dismissed
  ) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[visibleStatus.provider] ?? visibleStatus.provider;
  const defaultMessage =
    visibleStatus.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const variant = visibleStatus.status === "error" ? "error" : "warning";
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <StatusBanner
        variant={variant}
        icon={<CircleAlertIcon />}
        title={title}
        description={
          <span className="line-clamp-3" title={visibleStatus.message ?? defaultMessage}>
            {visibleStatus.message ?? defaultMessage}
          </span>
        }
        onDismiss={() => {
          if (getRetainedHistoryAdvisory(status)) retainedHistoryAdvisoryState.dismiss();
          setDismissed(true);
        }}
      />
    </div>
  );
});
