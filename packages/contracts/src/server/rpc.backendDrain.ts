import * as Rpc from "effect/unstable/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  BACKEND_DRAIN_WS_METHODS,
  BackendDrainConsentError,
  BackendDrainConsentSnapshot,
  BackendDrainDecisionResult,
  DecideBackendDrainInput,
} from "./backendDrain";

export const WsServerGetBackendDrainConsentRpc = Rpc.make(BACKEND_DRAIN_WS_METHODS.get, {
  success: Schema.NullOr(BackendDrainConsentSnapshot),
  error: BackendDrainConsentError,
});

export const WsServerDecideBackendDrainConsentRpc = Rpc.make(BACKEND_DRAIN_WS_METHODS.decide, {
  payload: DecideBackendDrainInput,
  success: BackendDrainDecisionResult,
  error: BackendDrainConsentError,
});
