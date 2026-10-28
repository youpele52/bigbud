import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ComputerUseActivitySnapshot,
  ComputerUseStopError,
  ComputerUseStopResult,
} from "./computerUseActivity";

/** Emits the current snapshot first, then each change. */
export const WsSubscribeComputerUseActivityRpc = Rpc.make(WS_METHODS.subscribeComputerUseActivity, {
  payload: Schema.Struct({}),
  success: ComputerUseActivitySnapshot,
  stream: true,
});

/** Interrupts every turn using computer use and resets the Cua driver. */
export const WsComputerUseStopRpc = Rpc.make(WS_METHODS.computerUseStop, {
  payload: Schema.Struct({}),
  success: ComputerUseStopResult,
  error: ComputerUseStopError,
});
