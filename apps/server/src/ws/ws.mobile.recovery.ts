import {
  MOBILE_RECOVERY_WS_METHODS,
  MobileRecoveryCommandOutcomeError,
  type MobileRecoveryCommandOutcomeInput,
} from "@bigbud/contracts/server/mobile.recovery";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { observeRpcEffect } from "../observability/RpcInstrumentation";
import type { WsRpcContext } from "./wsRpcContext";

function validateMobileRequestSession(
  context: WsRpcContext,
  request: HttpServerRequest.HttpServerRequest,
) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return Effect.succeed(null);
  const token = url.value.searchParams.get("token");
  return token === null
    ? Effect.succeed(null)
    : context.mobileRemoteControl.validateSessionToken(token);
}

export function makeMobileRecoveryOutcomeHandler(context: WsRpcContext) {
  return {
    [MOBILE_RECOVERY_WS_METHODS.getCommandOutcome]: (input: MobileRecoveryCommandOutcomeInput) =>
      observeRpcEffect(
        MOBILE_RECOVERY_WS_METHODS.getCommandOutcome,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* validateMobileRequestSession(context, request);
          if (session === null) {
            return yield* new MobileRecoveryCommandOutcomeError({
              message: "Mobile session is no longer authorized",
            });
          }
          const getCommandOutcome = context.orchestrationEngine.getCommandOutcome;
          if (getCommandOutcome === undefined) {
            return yield* new MobileRecoveryCommandOutcomeError({
              message: "Mobile command outcome is unavailable on this server",
            });
          }
          const outcome = yield* getCommandOutcome(input.commandId);
          if (
            outcome.status === "unknown" ||
            outcome.aggregateKind !== "thread" ||
            outcome.aggregateId !== input.threadId
          ) {
            return {
              commandId: input.commandId,
              status: "unknown" as const,
              serverEpoch: outcome.serverEpoch,
              canonicalRevision: outcome.canonicalRevision,
            };
          }
          if (outcome.status === "accepted") {
            return {
              commandId: input.commandId,
              status: "accepted" as const,
              resultSequence: outcome.resultSequence,
              serverEpoch: outcome.serverEpoch,
              canonicalRevision: outcome.canonicalRevision,
            };
          }
          return {
            commandId: input.commandId,
            status: "rejected" as const,
            resultSequence: outcome.resultSequence,
            reason: outcome.reason,
            serverEpoch: outcome.serverEpoch,
            canonicalRevision: outcome.canonicalRevision,
          };
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(MobileRecoveryCommandOutcomeError)(cause)
              ? cause
              : new MobileRecoveryCommandOutcomeError({
                  message: "Failed to read mobile command outcome",
                }),
          ),
        ),
        { "rpc.aggregate": "mobile-orchestration" },
      ),
  };
}
