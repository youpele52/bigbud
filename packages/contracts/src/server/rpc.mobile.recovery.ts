import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  MobileRecoveryBaseline,
  MobileRecoveryBaselineError,
  MobileRecoveryBaselineInput,
  MobileRecoveryCommandOutcome,
  MobileRecoveryCommandOutcomeError,
  MobileRecoveryCommandOutcomeInput,
  MOBILE_RECOVERY_WS_METHODS,
  MobileRecoveryFrame,
  MobileRecoverySubscriptionInput,
} from "./mobile.recovery";

export const WsMobileRecoveryBaselineRpc = Rpc.make(MOBILE_RECOVERY_WS_METHODS.getBaseline, {
  payload: MobileRecoveryBaselineInput,
  success: MobileRecoveryBaseline,
  error: MobileRecoveryBaselineError,
});

export const WsMobileRecoveryCommandOutcomeRpc = Rpc.make(
  MOBILE_RECOVERY_WS_METHODS.getCommandOutcome,
  {
    payload: MobileRecoveryCommandOutcomeInput,
    success: MobileRecoveryCommandOutcome,
    error: MobileRecoveryCommandOutcomeError,
  },
);

export const WsSubscribeMobileRecoveryRpc = Rpc.make(MOBILE_RECOVERY_WS_METHODS.subscribe, {
  payload: MobileRecoverySubscriptionInput,
  success: MobileRecoveryFrame,
  stream: true,
});
