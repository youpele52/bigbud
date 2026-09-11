import type { MobileCommandDeliveryStatus } from "../../../../lib/mobileCommandDelivery.logic";

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
    <div className="mb-2 grid gap-0.5 px-1 text-xs text-muted-foreground" role="status">
      {storageWarning ? <p>{storageWarning}</p> : null}
      {deliveryState === "uncertain" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-warning-foreground">Delivery is uncertain; no duplicate was sent.</p>
          {onCheckDelivery ? (
            <button
              className="min-h-11 rounded-md border border-border px-2 text-xs text-foreground"
              onClick={onCheckDelivery}
              type="button"
            >
              Check delivery
            </button>
          ) : null}
        </div>
      ) : null}
      {deliveryState === "reconciling" ? <p>Checking whether your message was accepted…</p> : null}
    </div>
  );
}
