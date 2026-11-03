import type { MobileCommandDeliveryStatus } from "../../../../lib/mobileCommandDelivery.logic";
import { Alert, AlertDescription } from "~/components/ui/alert";

export function MobileComposerDeliveryNotice({
  deliveryState,
  onCheckDelivery,
  storageWarning,
}: {
  readonly deliveryState: MobileCommandDeliveryStatus;
  readonly onCheckDelivery?: (() => void) | undefined;
  readonly storageWarning: string | null;
}) {
  if (!storageWarning && deliveryState !== "uncertain" && deliveryState !== "reconciling") {
    return null;
  }

  return (
    <Alert
      variant={storageWarning || deliveryState === "uncertain" ? "warning" : "loading"}
      className="mb-2 px-3 py-2"
      role="status"
    >
      <AlertDescription>
        {storageWarning ? <p>{storageWarning}</p> : null}
        {deliveryState === "uncertain" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-warning-foreground">Delivery is uncertain; no duplicate was sent.</p>
            {onCheckDelivery ? (
              <button
                className="min-h-11 rounded-md border border-border px-2 text-sm text-foreground"
                onClick={onCheckDelivery}
                type="button"
              >
                Check delivery
              </button>
            ) : null}
          </div>
        ) : null}
        {deliveryState === "reconciling" ? (
          <p>Checking whether your message was accepted…</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
