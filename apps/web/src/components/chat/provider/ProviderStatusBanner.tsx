import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@bigbud/contracts";
import { memo } from "react";
import { ChatBanner } from "../common/ChatBanner";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { withoutDismissedRetainedHistoryAdvisory } from "./ProviderStatusBanner.advisory";
import { useRetainedHistoryAdvisory } from "./useRetainedHistoryAdvisory";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
  threadId = "provider-status",
}: {
  status: ServerProvider | null;
  threadId?: string;
}) {
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, "provider-status", [
    status?.provider,
  ]);
  const advisoryDismissed = useRetainedHistoryAdvisory();
  const visibleStatus = withoutDismissedRetainedHistoryAdvisory(status, advisoryDismissed);

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
  const recovering = visibleStatus.recovery?.status === "retrying";
  const title = `${providerLabel} provider ${recovering ? "reconnecting" : visibleStatus.status === "error" ? "unavailable" : "needs attention"}`;
  const variant = recovering ? "loading" : visibleStatus.status === "error" ? "error" : "warning";
  return (
    <ChatBanner
      variant={variant}
      role={recovering ? "status" : "alert"}
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
