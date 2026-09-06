import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@bigbud/contracts";
import { CircleAlertIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { StatusBanner } from "../../common/StatusBanner";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  const prevKeyRef = useRef<string | null>(null);

  // Re-show banner when the provider or its message changes
  const key = status ? `${status.provider}:${status.status}:${status.message ?? ""}` : null;
  useEffect(() => {
    if (key && key !== prevKeyRef.current) {
      setDismissed(false);
      prevKeyRef.current = key;
    }
  }, [key]);

  if (!status || status.status === "ready" || status.status === "disabled" || dismissed) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;
  const variant = status.status === "error" ? "error" : "warning";
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <StatusBanner
        variant={variant}
        icon={<CircleAlertIcon />}
        title={title}
        description={
          <span className="line-clamp-3" title={status.message ?? defaultMessage}>
            {status.message ?? defaultMessage}
          </span>
        }
        onDismiss={() => setDismissed(true)}
      />
    </div>
  );
});
