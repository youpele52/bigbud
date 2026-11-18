import type { MobileCommandDeliveryStatus } from "../../../../lib/mobileCommandDelivery.logic";
import { Alert, AlertDescription } from "@bigbud/ui/alert";

/** Delivery of an approval, answer or interrupt, shown beside the composer send. */
export interface MobileDecisionDeliveryNotice {
  readonly status: MobileCommandDeliveryStatus;
  readonly onCheck: (() => void) | undefined;
  readonly previousAuthorization?: boolean;
  /** Offered only after a check found no record of the response on the server. */
  readonly onResend: (() => void) | undefined;
}

const isUnsettled = (status: MobileCommandDeliveryStatus | undefined) =>
  status === "uncertain" || status === "reconciling";

export function MobileComposerDeliveryNotice({
  deliveryState,
  deliveryFromPreviousAuthorization,
  onCheckDelivery,
  onResendDelivery,
  storageWarning,
  decision,
}: {
  readonly deliveryState: MobileCommandDeliveryStatus;
  readonly deliveryFromPreviousAuthorization?: boolean | undefined;
  readonly onCheckDelivery?: (() => void) | undefined;
  /** Offered only after a check found no record of the message on the server. */
  readonly onResendDelivery?: (() => void) | undefined;
  readonly storageWarning: string | null;
  readonly decision?: MobileDecisionDeliveryNotice | undefined;
}) {
  if (
    !storageWarning &&
    !isUnsettled(deliveryState) &&
    !isUnsettled(decision?.status) &&
    decision?.status !== "rejected"
  ) {
    return null;
  }

  return (
    <Alert
      variant={
        decision?.status === "rejected"
          ? "error"
          : storageWarning || deliveryState === "uncertain" || decision?.status === "uncertain"
            ? "warning"
            : "loading"
      }
      className="mb-2 px-3 py-2"
      role="status"
    >
      <AlertDescription>
        {storageWarning ? <p>{storageWarning}</p> : null}
        {decision?.status === "rejected" ? (
          <p>Your response was rejected. It was not applied.</p>
        ) : null}
        {deliveryState === "uncertain" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-warning-foreground">
              {deliveryFromPreviousAuthorization
                ? "This message was sent under the previous authorization. Its outcome remains uncertain; it cannot be checked or resent with this connection."
                : onResendDelivery
                  ? "The desktop has no record of this message. Sending again reuses the same ID, so it cannot run twice."
                  : "Delivery is uncertain; no duplicate was sent."}
            </p>
            {onResendDelivery ? (
              <button
                className="min-h-11 rounded-md border border-border px-2 text-sm text-foreground"
                onClick={onResendDelivery}
                type="button"
              >
                Send again
              </button>
            ) : null}
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
        {decision?.status === "uncertain" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-warning-foreground">
              {decision.previousAuthorization
                ? "This response was sent under the previous authorization. Its outcome remains uncertain; it cannot be checked or resent with this connection."
                : decision.onResend
                  ? "The desktop has no record of your response. Sending again reuses the same ID, so it cannot apply twice."
                  : "Your response may not have reached the desktop; it was not sent twice."}
            </p>
            {decision.onResend ? (
              <button
                className="min-h-11 rounded-md border border-border px-2 text-sm text-foreground"
                onClick={decision.onResend}
                type="button"
              >
                Send response again
              </button>
            ) : null}
            {decision.onCheck ? (
              <button
                className="min-h-11 rounded-md border border-border px-2 text-sm text-foreground"
                onClick={decision.onCheck}
                type="button"
              >
                Check response
              </button>
            ) : null}
          </div>
        ) : null}
        {decision?.status === "reconciling" ? (
          <p>Checking whether your response was accepted…</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
