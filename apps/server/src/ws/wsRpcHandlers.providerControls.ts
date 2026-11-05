import { Effect } from "effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  ProviderControlsError,
  ProviderControlsInput,
} from "@bigbud/contracts/server/providerControls";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { decodeInputOrValidationError } from "../provider/Layers/ProviderServiceHelpers.ts";
import type { WsRpcContext } from "./wsRpcContext";

/** Uses the authenticated WS group; validation precedes all provider access. */
export function makeWsRpcProviderControlsHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.providerControls]: (rawInput: ProviderControlsInput) =>
      observeRpcEffect(
        WS_METHODS.providerControls,
        Effect.gen(function* () {
          const input = yield* decodeInputOrValidationError({
            operation: "providerControls",
            schema: ProviderControlsInput,
            payload: rawInput,
          });
          if (!context.providerService.providerControls)
            return yield* new ProviderControlsError({
              message: "Native maintenance is unavailable on this server.",
            });
          return yield* context.providerService.providerControls(input);
        }).pipe(
          Effect.mapError(
            () =>
              new ProviderControlsError({
                message:
                  "Native maintenance was rejected or its outcome is unknown. Refresh status before taking further action; do not automatically retry.",
              }),
          ),
        ),
        { "rpc.aggregate": "provider" },
      ),
  };
}
