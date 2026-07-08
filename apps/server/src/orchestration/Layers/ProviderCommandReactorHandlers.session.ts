import {
  DEFAULT_RUNTIME_MODE,
  type OrchestrationSession,
  ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import {
  formatProviderServiceCauseDetail,
  isUnknownPendingApprovalRequestError,
  isUnknownPendingUserInputRequestError,
  stalePendingRequestDetail,
} from "./ProviderCommandReactorHelpers.ts";

type ProviderIntentEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  {
    type:
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

interface ProcessSessionHandlersDeps {
  readonly providerService: typeof ProviderService.Service;
  readonly appendProviderFailureActivity: (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) => Effect.Effect<void, OrchestrationDispatchError, never>;
  readonly resolveThread: (
    threadId: ThreadId,
  ) => Effect.Effect<import("@bigbud/contracts").OrchestrationThread | undefined, never, never>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError, never>;
}

export const makeProcessSessionHandlers = ({
  providerService,
  appendProviderFailureActivity,
  resolveThread,
  setThreadSession,
}: ProcessSessionHandlersDeps) => {
  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const runtimeSession = yield* providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === thread.id)));
    const boundSession =
      thread.session && thread.session.status !== "stopped" ? thread.session : null;

    if (!boundSession && !runtimeSession) {
      return;
    }

    if (
      event.payload.turnId !== undefined &&
      event.payload.turnId !== (runtimeSession?.activeTurnId ?? boundSession?.activeTurnId ?? null)
    ) {
      return;
    }

    yield* providerService.interruptTurn({
      threadId: event.payload.threadId,
      ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
    });
    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "ready",
        providerName: runtimeSession?.provider ?? boundSession?.providerName ?? null,
        runtimeMode:
          runtimeSession?.runtimeMode ?? boundSession?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        reason: null,
        lastError: boundSession?.lastError ?? runtimeSession?.lastError ?? null,
        updatedAt: event.payload.createdAt,
      },
      createdAt: event.payload.createdAt,
    });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
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
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
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
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  return {
    processApprovalResponseRequested,
    processSessionStopRequested,
    processTurnInterruptRequested,
    processUserInputResponseRequested,
  };
};
