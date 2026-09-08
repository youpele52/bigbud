import { memo } from "react";
import { CircleAlertIcon } from "lucide-react";
import { StatusBanner } from "../../common/StatusBanner";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
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
        {...(onDismiss ? { onDismiss } : {})}
      />
    </div>
  );
});
