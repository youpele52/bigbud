import {
  createMobileCommandDeliveryController,
  type MobileCommandDeliveryController,
} from "../lib/mobileCommandDelivery";
import {
  createMobileCommandDeliveryState,
  type MobileCommandDeliveryState,
} from "../lib/mobileCommandDelivery.logic";
import type { MobileComposerDraft } from "../lib/mobileComposerDraft";

interface MobileDeliveryOwner {
  readonly identity: string;
  readonly delivery: MobileCommandDeliveryController;
  readonly decisionDelivery: MobileCommandDeliveryController;
  readonly retired: boolean;
  readonly recreate: () => MobileDeliveryOwner;
  readonly dispose: () => void;
}

export function createMobileDeliveryOwner(input: {
  readonly identity: string;
  readonly submitted: MobileComposerDraft["submitted"];
  readonly decisionSubmitted: MobileComposerDraft["submitted"];
  readonly onStateChange: (state: MobileCommandDeliveryState) => void;
  readonly onDecisionStateChange: (state: MobileCommandDeliveryState) => void;
}) {
  function create(
    promptState: MobileCommandDeliveryState,
    decisionState: MobileCommandDeliveryState,
  ): MobileDeliveryOwner {
    const delivery = createMobileCommandDeliveryController({
      initialState: promptState,
      onStateChange: input.onStateChange,
    });
    const decisionDelivery = createMobileCommandDeliveryController({
      initialState: decisionState,
      onStateChange: input.onDecisionStateChange,
    });
    let retired = false;
    return {
      identity: input.identity,
      delivery,
      decisionDelivery,
      get retired() {
        return retired;
      },
      recreate: () => create(delivery.getState(), decisionDelivery.getState()),
      dispose() {
        if (retired) return;
        retired = true;
        delivery.dispose();
        decisionDelivery.dispose();
      },
    };
  }
  return create(
    createMobileCommandDeliveryState(input.submitted),
    createMobileCommandDeliveryState(input.decisionSubmitted),
  );
}
