import { memo } from "react";
import { CircleAlertIcon } from "lucide-react";
import { StatusBanner } from "../../common/StatusBanner";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  threadId,
  conditionIdentity,
}: {
  error: string | null;
  threadId: string;
  conditionIdentity?: unknown;
}) {
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, "error", [
    error,
    conditionIdentity,
  ]);
  if (!error || dismissed) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <StatusBanner
        variant="error"
        icon={<CircleAlertIcon />}
        description={
          <span className="line-clamp-3" title={error}>
            {error}
          </span>
        }
        dismissLabel="Dismiss error"
        onDismiss={dismiss}
      />
    </div>
  );
});
