import { Effect, Layer, Stream } from "effect";

import { ProviderAdapterValidationError } from "../../Errors.ts";
import {
  OpencodeV2Adapter,
  type OpencodeV2AdapterShape,
} from "../../Services/OpencodeV2/Adapter.ts";
import { OPENCODE_V2_DORMANT_CAPABILITIES } from "./Compatibility.ts";

/** Typed dormant boundary: persisted V2 IDs never reach a V1 adapter or fresh-session fallback. */
export function makeDormantOpencodeV2Adapter(): OpencodeV2AdapterShape {
  const unavailable = (operation: string) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: "opencodeV2",
        operation,
        issue:
          "OpenCode v2 execution is unavailable until generation, admission recovery, and isolation conformance gates pass.",
      }),
    );
  return {
    provider: "opencodeV2",
    capabilities: OPENCODE_V2_DORMANT_CAPABILITIES,
    startSession: () => unavailable("startSession"),
    sendTurn: (input) =>
      input.requestMessageId
        ? unavailable("sendTurn")
        : Effect.fail(
            new ProviderAdapterValidationError({
              provider: "opencodeV2",
              operation: "sendTurn",
              issue: "OpenCode v2 requires a durable requestMessageId before dispatch.",
            }),
          ),
    interruptTurn: () => unavailable("interruptTurn"),
    inspectActiveTurn: () =>
      Effect.succeed({ status: "unavailable", observedAt: new Date().toISOString() }),
    respondToRequest: () => unavailable("respondToRequest"),
    respondToUserInput: () => unavailable("respondToUserInput"),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => unavailable("readThread"),
    rollbackThread: () => unavailable("rollbackThread"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

export const OpencodeV2AdapterLive = Layer.sync(OpencodeV2Adapter, makeDormantOpencodeV2Adapter);
