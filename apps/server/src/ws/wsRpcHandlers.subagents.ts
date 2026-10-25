import { Effect } from "effect";
import { WS_METHODS } from "@bigbud/contracts";
import {
  ProviderStopSubagentError,
  type ProviderStopSubagentInput,
} from "@bigbud/contracts/server/subagents";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import type { WsRpcContext } from "./wsRpcContext";

const FALLBACK_MESSAGE = "Could not stop the subagent.";

function toStopSubagentError(cause: unknown): ProviderStopSubagentError {
  const message =
    cause instanceof Error && cause.message.trim().length > 0
      ? cause.message.trim()
      : FALLBACK_MESSAGE;
  return new ProviderStopSubagentError({ message, cause });
}

/** Per-subagent Stop (D3). Stop-all keeps using the existing interrupt path. */
export function makeWsRpcSubagentHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.providerStopSubagent]: (input: ProviderStopSubagentInput) =>
      observeRpcEffect(
        WS_METHODS.providerStopSubagent,
        Effect.gen(function* () {
          const stopSubagent = context.providerService.stopSubagent;
          if (!stopSubagent) {
            return yield* new ProviderStopSubagentError({ message: FALLBACK_MESSAGE });
          }
          yield* stopSubagent(input);
        }).pipe(Effect.mapError(toStopSubagentError)),
        { "rpc.aggregate": "provider" },
      ),
  };
}
