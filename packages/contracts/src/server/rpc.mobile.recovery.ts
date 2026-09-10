import * as Rpc from "effect/unstable/rpc/Rpc";

import {
  MobileRecoveryBaseline,
  MobileRecoveryBaselineError,
  MobileRecoveryBaselineInput,
  MOBILE_RECOVERY_WS_METHODS,
  MobileRecoveryFrame,
  MobileRecoverySubscriptionInput,
} from "./mobile.recovery";

export const WsMobileRecoveryBaselineRpc = Rpc.make(MOBILE_RECOVERY_WS_METHODS.getBaseline, {
  payload: MobileRecoveryBaselineInput,
  success: MobileRecoveryBaseline,
  error: MobileRecoveryBaselineError,
});

export const WsSubscribeMobileRecoveryRpc = Rpc.make(MOBILE_RECOVERY_WS_METHODS.subscribe, {
  payload: MobileRecoverySubscriptionInput,
  success: MobileRecoveryFrame,
  stream: true,
});
