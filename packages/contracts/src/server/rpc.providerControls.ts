import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  ProviderControlsError,
  ProviderControlsInput,
  ProviderControlsSnapshot,
} from "./providerControls";

export const WsProviderControlsRpc = Rpc.make(WS_METHODS.providerControls, {
  payload: ProviderControlsInput,
  success: ProviderControlsSnapshot,
  error: ProviderControlsError,
});
