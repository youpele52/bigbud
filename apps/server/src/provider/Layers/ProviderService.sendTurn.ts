/**
 * `ProviderService.sendTurn`: routes one user turn to its provider adapter.
 *
 * Before the external `adapter.sendTurn` call, the dispatch attempt for the turn's recovery
 * intent is durably `prepared` and then `may-have-been-sent`. If that write fails, the turn is
 * not sent and fails as a turn-start failure, so a later recovery can never mistake a
 * possibly-delivered prompt for one that never left. After the call, `provider-acknowledged`
 * commits together with the turn's liveness and runtime binding.
 *
 * @module ProviderService.sendTurn
 */
import { createHash } from "node:crypto";

import { ProviderSendTurnInput, type ChatAttachment } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import type { ProviderDispatchAttemptRepositoryShape } from "../../persistence/Services/ProviderDispatchAttempts.ts";
import type { ProviderTurnLivenessRepositoryShape } from "../../persistence/Services/ProviderTurnLiveness.ts";
import type { AnalyticsServiceShape } from "../../telemetry/Services/AnalyticsService.ts";
import { ProviderDispatchAttemptPersistenceError } from "../Errors.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";
import { recordAcceptedSendTurn } from "./ProviderService.sendTurn.record.ts";
import { decodeInputOrValidationError, toValidationError } from "./ProviderServiceHelpers.ts";

/** Stable digest of what was sent, so a later attempt can be compared with this one. */
export function dispatchPayloadDigest(input: {
  readonly input?: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: { readonly provider: string; readonly model: string } | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        input: input.input ?? null,
        attachments: input.attachments.map((attachment) => attachment.id),
        provider: input.modelSelection?.provider ?? null,
        model: input.modelSelection?.model ?? null,
      }),
    )
    .digest("hex");
}

export function makeSendTurn(deps: {
  readonly resolveRoutableSession: ResolveRoutableSession;
  readonly directory: ProviderSessionDirectoryShape;
  readonly liveness: Option.Option<ProviderTurnLivenessRepositoryShape>;
  readonly dispatchAttempts: Option.Option<ProviderDispatchAttemptRepositoryShape>;
  readonly analytics: AnalyticsServiceShape;
}): ProviderServiceShape["sendTurn"] {
  return Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = { ...parsed, attachments: parsed.attachments ?? [] };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* deps.resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
        ...(input.sessionEpoch !== undefined ? { expectedSessionEpoch: input.sessionEpoch } : {}),
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const attempts = Option.getOrUndefined(deps.dispatchAttempts);
      const attempt =
        attempts !== undefined && input.requestMessageId !== undefined
          ? yield* attempts
              .markMayHaveBeenSent({
                threadId: input.threadId,
                messageId: input.requestMessageId,
                provider: routed.adapter.provider,
                payloadDigest: dispatchPayloadDigest(input),
                at: new Date().toISOString(),
              })
              .pipe(
                // Raised before the send: recovery may treat the turn as never sent.
                Effect.mapError(
                  (cause) =>
                    new ProviderDispatchAttemptPersistenceError({
                      threadId: input.threadId,
                      detail: cause.message,
                      cause,
                    }),
                ),
              )
          : Option.none();
      const turn = yield* routed.adapter.sendTurn(input);
      yield* recordAcceptedSendTurn({
        adapter: routed.adapter,
        directory: deps.directory,
        liveness: deps.liveness,
        threadId: input.threadId,
        turnId: turn.turnId,
        sessionEpoch: input.sessionEpoch ?? 0,
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(Option.isSome(attempt) && attempts !== undefined
          ? {
              acknowledge: (writes) =>
                attempts.acknowledgeWith(
                  {
                    attemptId: attempt.value.attemptId,
                    threadId: input.threadId,
                    messageId: attempt.value.messageId,
                    turnId: turn.turnId,
                    provider: routed.adapter.provider,
                    at: new Date().toISOString(),
                  },
                  writes,
                ),
            }
          : {}),
      });
      yield* deps.analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: { operation: "send" },
          }),
      }),
    );
  });
}
