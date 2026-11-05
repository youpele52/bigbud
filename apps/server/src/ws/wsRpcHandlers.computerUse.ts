import { WS_METHODS } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  makeComputerUseActivityStream,
  makeComputerUseStop,
} from "../computer-use/computerUseStop.ts";
import { ComputerUseActivity } from "../computer-use/Services/ComputerUseActivity.ts";
import { CuaDriver } from "../computer-use/Services/CuaDriver.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext";

/**
 * Mascot "Stop computer use": activity for the menu, and the Stop. The registry is required so a
 * server that forgets to provide it fails to build instead of silently never offering Stop; it is
 * the same instance the engine's tool dispatcher records into (one `ComputerUseLayerLive`).
 */
export const makeWsRpcComputerUseHandlers = Effect.fn("makeWsRpcComputerUseHandlers")(function* (
  context: WsRpcContext,
) {
  const deps = {
    activity: yield* ComputerUseActivity,
    engine: context.orchestrationEngine,
    driver: Option.getOrNull(yield* Effect.serviceOption(CuaDriver)),
  };
  const stop = makeComputerUseStop(deps);
  const activityStream = makeComputerUseActivityStream(deps);

  return {
    [WS_METHODS.subscribeComputerUseActivity]: (_input: unknown) =>
      observeRpcStream(WS_METHODS.subscribeComputerUseActivity, activityStream, {
        "rpc.aggregate": "computer-use",
      }),
    [WS_METHODS.computerUseStop]: (_input: unknown) =>
      observeRpcEffect(WS_METHODS.computerUseStop, stop, { "rpc.aggregate": "computer-use" }),
  };
});
