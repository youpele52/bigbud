import { useEffect, useRef } from "react";

import {
  createMobileCommandDeliveryController,
  type MobileCommandDeliveryController,
} from "../lib/mobileCommandDelivery";
import { createMobileCommandDeliveryState } from "../lib/mobileCommandDelivery.logic";
import type { MobileComposerDraft } from "../lib/mobileComposerDraft";

export function useMobileThreadDelivery(input: {
  readonly identity: string;
  readonly submitted: MobileComposerDraft["submitted"];
  readonly onStateChange: (state: ReturnType<MobileCommandDeliveryController["getState"]>) => void;
}): {
  readonly delivery: MobileCommandDeliveryController;
  readonly decisionDelivery: MobileCommandDeliveryController;
} {
  const deliveryRef = useRef<{
    readonly identity: string;
    readonly delivery: MobileCommandDeliveryController;
    readonly decisionDelivery: MobileCommandDeliveryController;
  } | null>(null);
  if (deliveryRef.current?.identity !== input.identity) {
    deliveryRef.current = {
      identity: input.identity,
      delivery: createMobileCommandDeliveryController({
        initialState: createMobileCommandDeliveryState(input.submitted),
        onStateChange: input.onStateChange,
      }),
      decisionDelivery: createMobileCommandDeliveryController(),
    };
  }
  const owner = deliveryRef.current;
  if (!owner) throw new Error("Mobile delivery owner was not initialized.");

  useEffect(() => {
    return () => {
      owner.delivery.dispose();
      owner.decisionDelivery.dispose();
    };
  }, [owner]);

  return { delivery: owner.delivery, decisionDelivery: owner.decisionDelivery };
}
