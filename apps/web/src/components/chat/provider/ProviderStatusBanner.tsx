import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@bigbud/contracts";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";

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
  const dismissButtonClass =
    variant === "error"
      ? "inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
      : "inline-flex size-6 items-center justify-center rounded-md text-warning/60 transition-colors hover:text-warning";

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={variant}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss"
            className={dismissButtonClass}
            onClick={() => setDismissed(true)}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
