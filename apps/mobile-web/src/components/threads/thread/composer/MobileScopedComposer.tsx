import type { ComponentProps } from "react";
import type { StoredMobileSession } from "../../../../lib/mobileSession";
import { MobileComposerDeliveryNotice } from "./MobileComposerDeliveryNotice";
import { MobileComposer } from "./MobileComposer";

export function MobileScopedComposer({
  sessionScope,
  ...props
}: ComponentProps<typeof MobileComposer> & {
  readonly sessionScope: StoredMobileSession["scope"] | undefined;
}) {
  if (sessionScope === "thread-control") return <MobileComposer {...props} />;
  const canRespond = sessionScope === "approve-only" && props.pendingApproval;
  return (
    <>
      <p className="px-4 py-3 text-sm text-muted-foreground" role="status">
        {sessionScope === "approve-only"
          ? "This connection can respond to approvals. Sending messages, answering questions and stopping turns require thread control."
          : "This connection is read-only. You can follow the conversation here."}
      </p>
      {props.value ? (
        <textarea
          aria-label={
            props.deliveryFromPreviousAuthorization
              ? "Retained draft from previous authorization"
              : "Saved draft"
          }
          className="mx-3 max-h-32 min-h-11 resize-none rounded-md border border-border p-3 text-sm"
          readOnly
          value={props.value}
        />
      ) : null}
      {!canRespond ? (
        <MobileComposerDeliveryNotice
          deliveryFromPreviousAuthorization={props.deliveryFromPreviousAuthorization}
          deliveryState={props.deliveryState ?? "idle"}
          onCheckDelivery={props.onCheckDelivery}
          storageWarning={props.storageWarning ?? null}
          decision={
            props.decisionDelivery
              ? {
                  ...props.decisionDelivery,
                  onResend:
                    sessionScope === "approve-only" ? props.decisionDelivery.onResend : undefined,
                }
              : undefined
          }
        />
      ) : null}
      {canRespond ? (
        <MobileComposer
          {...props}
          pendingUserInput={null}
          isRunning={false}
          modelSelection={null}
          onStop={undefined}
          onResendDelivery={undefined}
        />
      ) : null}
    </>
  );
}
