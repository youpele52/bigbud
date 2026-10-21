import { isWsTransportDisconnectedError } from "../rpc/wsTransport.errors";
import { containDeliveryApplicationFailure } from "./-__root.delivery-routing";

/**
 * Rejection handler for one delivery item. A dropped socket is not an application failure: it
 * skips bounded recovery so the resubscription replays from the persisted cursor instead.
 */
export function handleDeliveryApplicationFailure(input: {
  readonly itemType: "lifecycle" | "recovery" | "batch";
  readonly error: unknown;
  readonly fallbackToBoundedRecovery: () => Promise<void>;
}): Promise<never> {
  if (isWsTransportDisconnectedError(input.error)) return Promise.reject(input.error);
  console.error("[orchestration-recovery] Event application failed.", { error: input.error });
  return containDeliveryApplicationFailure(input);
}
