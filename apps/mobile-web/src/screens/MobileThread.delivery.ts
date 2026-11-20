import { mobileComposerDraftKey } from "../lib/mobileComposerDraft.identity";
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import type { MobileCommandDeliveryController } from "../lib/mobileCommandDelivery";
import { type MobileCommandDeliveryState } from "../lib/mobileCommandDelivery.logic";
import type { MobileComposerDraft, MobileComposerDraftIdentity } from "../lib/mobileComposerDraft";
import type { MobileRecoveryFreshness } from "../logic/mobileRecovery.types";
import { createMobileDeliveryOwner } from "./MobileThread.delivery.owner";
import { createMobileDeliveryReconciliationTracker } from "./MobileThread.delivery.reconciliation";
export { selectCommandToRecheck } from "./MobileThread.delivery.reconciliation";

/**
 * Owns the thread's delivery controllers. Called before any early return in
 * `MobileThread`, so its hooks run on every render.
 *
 * Both the composer send and decisions (approval, answer, interrupt) are
 * restored after a reload with their original command IDs.
 *
 * `recheckRef` is assigned the thread's current check functions once commands
 * exist. Whenever the live stream is caught up, each uncertain operation is
 * then checked once by its command ID (see `selectCommandToRecheck`). Nothing
 * is resent automatically.
 */
export function useMobileThreadDelivery(input: {
  readonly identity: MobileComposerDraftIdentity | null;
  readonly threadId: string;
  readonly freshness: MobileRecoveryFreshness;
  readonly submitted: MobileComposerDraft["submitted"];
  readonly decisionSubmitted: MobileComposerDraft["submitted"];
  readonly onStateChange: (state: MobileCommandDeliveryState) => void;
  readonly onDecisionStateChange: (state: MobileCommandDeliveryState) => void;
}): {
  readonly delivery: MobileCommandDeliveryController;
  readonly decisionDelivery: MobileCommandDeliveryController;
  readonly recheckRef: MutableRefObject<MobileDeliveryRechecks | null>;
} {
  const identityKey = input.identity ? mobileComposerDraftKey(input.identity) : input.threadId;
  const [owner, setOwner] = useState(() =>
    createMobileDeliveryOwner({ ...input, identity: identityKey }),
  );
  if (owner.identity !== identityKey)
    setOwner(createMobileDeliveryOwner({ ...input, identity: identityKey }));

  useEffect(() => {
    if (owner.retired) {
      // StrictMode replays setup after cleanup with the same hook state. A terminal
      // controller must be replaced; its uncertain operation keeps the original ID.
      setOwner((current) => (current === owner ? owner.recreate() : current));
      return;
    }
    return () => owner.dispose();
  }, [owner]);

  const recheckRef = useRef<MobileDeliveryRechecks | null>(null);
  // Command IDs already checked in the current caught-up period.
  const trackerRef = useRef<ReturnType<typeof createMobileDeliveryReconciliationTracker> | null>(
    null,
  );
  if (trackerRef.current === null) trackerRef.current = createMobileDeliveryReconciliationTracker();
  const tracker = trackerRef.current;
  // No dependency list: the check is cheap and must also run once `recheckRef`
  // is first assigned, which happens during a later render than the catch-up.
  useEffect(() => {
    // Leaving "current" starts a new period, so the next catch-up may check again.
    if (input.freshness !== "current") {
      tracker.reset();
      return;
    }
    if (owner.retired) return;
    const rechecks = recheckRef.current;
    if (rechecks === null) return;
    for (const [controller, recheck] of [
      [owner.delivery, rechecks.prompt],
      [owner.decisionDelivery, rechecks.decision],
    ] as const) {
      const commandId = tracker.select(controller);
      if (commandId === null) continue;
      void recheck();
    }
  });

  return { delivery: owner.delivery, decisionDelivery: owner.decisionDelivery, recheckRef };
}

/** Check functions for the composer send and for decisions. */
export interface MobileDeliveryRechecks {
  readonly prompt: () => Promise<unknown>;
  readonly decision: () => Promise<unknown>;
}

/** Delivery props for the composer, from both controllers and the thread's commands. */
export function buildMobileComposerDeliveryProps(input: {
  readonly delivery: MobileCommandDeliveryController;
  readonly decisionDelivery: MobileCommandDeliveryController;
  readonly commands: {
    readonly checkDelivery: () => Promise<unknown>;
    readonly resendDelivery: (() => void) | undefined;
    readonly checkDecisionDelivery: () => Promise<unknown>;
    readonly resendDecisionDelivery: (() => Promise<void>) | undefined;
  };
}) {
  const { commands } = input;
  const resendDecision = commands.resendDecisionDelivery;
  const previousAuthorization = !!input.delivery.getState().operation?.receiptSource;
  const previousDecisionAuthorization =
    !!input.decisionDelivery.getState().operation?.receiptSource;
  return {
    deliveryFromPreviousAuthorization: previousAuthorization,
    deliveryState: input.delivery.getState().status,
    onCheckDelivery: previousAuthorization ? undefined : () => void commands.checkDelivery(),
    onResendDelivery: previousAuthorization ? undefined : commands.resendDelivery,
    decisionDelivery: {
      status: input.decisionDelivery.getState().status,
      previousAuthorization: previousDecisionAuthorization,
      onCheck: previousDecisionAuthorization
        ? undefined
        : () => void commands.checkDecisionDelivery(),
      onResend:
        !previousDecisionAuthorization && resendDecision ? () => void resendDecision() : undefined,
    },
  };
}
