import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@bigbud/contracts";
import { CircleAlertIcon } from "lucide-react";
import { memo } from "react";
import { ChatBanner } from "../common/ChatBanner";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { withoutDismissedRetainedHistoryAdvisory } from "./ProviderStatusBanner.advisory";
import { useRetainedHistoryAdvisory } from "./useRetainedHistoryAdvisory";
import { withoutVerifiedRuntimeNotice } from "./ProviderStatusBanner.qualification";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
  runtimeVerified = false,
  threadId = "provider-status",
}: {
  status: ServerProvider | null;
  runtimeVerified?: boolean;
  threadId?: string;
}) {
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, "provider-status", [
    status?.provider,
  ]);
  const advisoryDismissed = useRetainedHistoryAdvisory();
  const visibleStatus = withoutDismissedRetainedHistoryAdvisory(
    withoutVerifiedRuntimeNotice(status, runtimeVerified),
    advisoryDismissed,
  );

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
    <ChatBanner
      variant={variant}
      icon={<CircleAlertIcon />}
      title={title}
      description={
        <span className="line-clamp-3" title={visibleStatus.message ?? defaultMessage}>
          {visibleStatus.message ?? defaultMessage}
        </span>
      }
      dismissLabel="Dismiss provider status"
      onDismiss={dismiss}
    />
  );
});
