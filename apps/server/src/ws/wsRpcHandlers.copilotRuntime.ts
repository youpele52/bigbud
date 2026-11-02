import { WS_METHODS } from "@bigbud/contracts";
import {
  CopilotRuntimeError,
  type CopilotRuntimeInput,
} from "@bigbud/contracts/server/copilotRuntime";
import { Effect } from "effect";
import { copilotRuntimeRequest } from "../provider/Layers/Copilot/Runtime.service.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

export function makeWsRpcCopilotRuntimeHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverCopilotRuntime]: (input: CopilotRuntimeInput) =>
      Effect.gen(function* () {
        const settings = yield* context.serverSettings.getSettings;
        return yield* Effect.tryPromise({
          try: () => copilotRuntimeRequest(input, settings.providers.copilot.binaryPath),
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        });
      }).pipe(
        Effect.mapError(
          (error) =>
            new CopilotRuntimeError({ message: typeof error === "string" ? error : error.message }),
        ),
      ),
  };
}
