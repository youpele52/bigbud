import { ThreadId, type TurnId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { setTurnControlOperation } from "./ProviderCommandReactorHandlers.steer.ts";
import {
  formatProviderServiceCauseDetail,
  isUnknownPendingApprovalRequestError,
  isUnknownPendingUserInputRequestError,
  stalePendingRequestDetail,
} from "./ProviderCommandReactorHelpers.ts";

type ProviderResponseIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

interface ProcessSessionResponseHandlersDeps {
  readonly providerService: typeof ProviderService.Service;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly appendProviderFailureActivity: (input: {
    readonly threadId: ThreadId;
    readonly kind: "provider.approval.respond.failed" | "provider.user-input.respond.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) => Effect.Effect<void, OrchestrationDispatchError, never>;
  readonly resolveThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThread | undefined, never, never>;
}

export const makeProcessSessionResponseHandlers = ({
  providerService,
  orchestrationEngine,
  appendProviderFailureActivity,
  resolveThread,
}: ProcessSessionResponseHandlersDeps) => {
  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderResponseIntentEvent, { type: "thread.approval-response-requested" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
    if (event.payload.requestId.startsWith("learning-skill:")) {
      return;
    }
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : formatProviderServiceCauseDetail(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderResponseIntentEvent, { type: "thread.user-input-response-requested" }>,
    ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : formatProviderServiceCauseDetail(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderResponseIntentEvent, { type: "thread.session-stop-requested" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session?.activeTurnId) {
      yield* providerService.interruptTurn({
        threadId: thread.id,
        turnId: thread.session.activeTurnId,
        sessionEpoch: event.payload.operation?.sessionEpoch ?? thread.session.sessionEpoch ?? 0,
      });
    }
    if (event.payload.operation) {
      yield* setTurnControlOperation({
        orchestrationEngine,
        threadId: thread.id,
        operation: event.payload.operation,
        state: thread.session?.activeTurnId ? "waiting-for-settlement" : "completed",
        createdAt: now,
      });
    }
  });

  return {
    processApprovalResponseRequested,
    processSessionStopRequested,
    processUserInputResponseRequested,
  };
};
