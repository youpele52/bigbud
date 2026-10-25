import { memo } from "react";
import { CircleAlertIcon } from "lucide-react";
import { ChatBanner } from "./ChatBanner";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { useProviderFailureNotice } from "./ThreadErrorBanner.failure";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  threadId,
  provider,
}: {
  error: string | null;
  threadId: string;
  provider?: string;
}) {
  const failure = useProviderFailureNotice(threadId);
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, "error", [provider]);
  const visibleError =
    failure.message ?? (error !== failure.originalMessage && !dismissed ? error : null);
  if (!visibleError) return null;
  return (
    <ChatBanner
      variant="error"
      icon={<CircleAlertIcon />}
      description={
        <span className="line-clamp-3" title={visibleError}>
          {visibleError}
        </span>
      }
      dismissLabel="Dismiss error"
      onDismiss={failure.message ? failure.dismiss : dismiss}
    />
  );
});
