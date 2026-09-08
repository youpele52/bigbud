import {
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationSession,
  ThreadId,
  type TurnId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { buildThreadReconciliationCommand } from "./ProviderRuntimeIngestion.reconcile.ts";
import { makeProcessSessionResponseHandlers } from "./ProviderCommandReactorHandlers.session.responses.ts";
import { settleInterruptAfterAcknowledgement } from "./ProviderCommandReactorHandlers.session.settle.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { formatProviderServiceCauseDetail } from "./ProviderCommandReactorHelpers.ts";
import { setTurnControlOperation } from "./ProviderCommandReactorHandlers.steer.ts";

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
  readonly orchestrationEngine: OrchestrationEngineShape;
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
    readonly expectedSessionEpoch?: number;
    readonly expectedActiveTurnId?: TurnId;
  }) => Effect.Effect<void, OrchestrationDispatchError, never>;
}

export const makeProcessSessionHandlers = ({
  orchestrationEngine,
  providerService,
  appendProviderFailureActivity,
  resolveThread,
  setThreadSession,
}: ProcessSessionHandlersDeps) => {
  const cancelPendingFlush = (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) =>
    event.payload.pendingFlushIntent === undefined
      ? Effect.void
      : orchestrationEngine
          .dispatch({
            type: "thread.queued-prompt.flush-cancel",
            commandId: serverCommandId("cancel-interrupt-flush"),
            threadId: event.payload.threadId,
            intentId: event.payload.pendingFlushIntent.intentId,
            createdAt: event.payload.createdAt,
          })
          .pipe(Effect.asVoid);

  const completeInterruptContinue = Effect.fn("completeInterruptContinue")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const operation = event.payload.operation;
    if (!operation) return;
    if (operation.reservedPromptIds.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.queued-prompt.flush",
        commandId: serverCommandId("interrupt-continue-flush"),
        threadId: event.payload.threadId,
        messageIds: operation.reservedPromptIds,
        messageId: MessageId.makeUnsafe(`continued:${operation.operationId}`),
        acknowledged: true,
        controlOperationId: operation.operationId,
        createdAt: event.payload.createdAt,
      });
    }
    yield* setTurnControlOperation({
      orchestrationEngine,
      threadId: event.payload.threadId,
      operation,
      state: "completed",
      createdAt: event.payload.createdAt,
    });
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ): Effect.fn.Return<void, ProviderServiceError | OrchestrationDispatchError> {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      yield* cancelPendingFlush(event);
      return;
    }
    let runtimeSession = yield* providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === thread.id)));
    const boundSession =
      thread.session && thread.session.status !== "stopped" ? thread.session : null;

    if (!boundSession && !runtimeSession) {
      yield* Effect.logWarning("provider turn interrupt could not find a live session", {
        threadId: thread.id,
        requestedTurnId: event.payload.turnId ?? null,
        hasPendingFlushIntent: event.payload.pendingFlushIntent !== undefined,
        queuedPromptIds: (thread.queuedPrompts ?? []).map((prompt) => prompt.id),
        queuedPromptCount: thread.queuedPrompts?.length ?? 0,
      });
      yield* appendProviderFailureActivity({
        threadId: thread.id,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt did not find a live session",
        detail: "The projected turn was stale; no live provider session was available.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
      if (event.payload.pendingFlushIntent !== undefined) {
        yield* cancelPendingFlush(event);
        yield* setThreadSession({
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "stopped",
            providerName: null,
            runtimeMode: thread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            reason: "stale-provider-session",
            lastError: null,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
          expectedSessionEpoch: thread.session?.sessionEpoch ?? 0,
          ...(thread.session?.activeTurnId
            ? { expectedActiveTurnId: thread.session.activeTurnId }
            : {}),
        });
      }
      return;
    }

    if (
      event.payload.turnId !== undefined &&
      event.payload.turnId !== (runtimeSession?.activeTurnId ?? boundSession?.activeTurnId ?? null)
    ) {
      yield* Effect.logWarning("provider turn interrupt ignored for a stale turn", {
        threadId: thread.id,
        projectedActiveTurnId: boundSession?.activeTurnId ?? null,
        liveActiveTurnId: runtimeSession?.activeTurnId ?? null,
        requestedTurnId: event.payload.turnId,
        hasPendingFlushIntent: event.payload.pendingFlushIntent !== undefined,
        queuedPromptIds: (thread.queuedPrompts ?? []).map((prompt) => prompt.id),
        queuedPromptCount: thread.queuedPrompts?.length ?? 0,
      });
      yield* appendProviderFailureActivity({
        threadId: thread.id,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt ignored for a stale turn",
        detail: `The requested turn does not match the live turn (projected=${boundSession?.activeTurnId ?? "none"}, live=${runtimeSession?.activeTurnId ?? "none"}).`,
        turnId: event.payload.turnId,
        createdAt: event.payload.createdAt,
      });
      yield* cancelPendingFlush(event);
      return;
    }

    const projectedTurnFence = boundSession?.activeTurnId ?? thread.latestTurn?.turnId ?? null;
    if (
      event.payload.pendingFlushIntent !== undefined &&
      event.payload.turnId === undefined &&
      runtimeSession?.activeTurnId != null &&
      runtimeSession.activeTurnId !== projectedTurnFence
    ) {
      yield* Effect.logWarning("provider turn interrupt rejected without a matching turn fence", {
        threadId: thread.id,
        projectedActiveTurnId: projectedTurnFence,
        liveActiveTurnId: runtimeSession.activeTurnId,
      });
      yield* appendProviderFailureActivity({
        threadId: thread.id,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt rejected without a matching turn fence",
        detail: `A live turn exists but the projected turn fence did not match (projected=${projectedTurnFence ?? "none"}, live=${runtimeSession.activeTurnId}).`,
        turnId: runtimeSession.activeTurnId,
        createdAt: event.payload.createdAt,
      });
      yield* cancelPendingFlush(event);
      return;
    }

    if (
      event.payload.pendingFlushIntent !== undefined &&
      (runtimeSession?.activeTurnId ?? boundSession?.activeTurnId ?? null) === null
    ) {
      const reconciliation = buildThreadReconciliationCommand({
        thread,
        liveSession: runtimeSession,
        occurredAt: event.payload.createdAt,
      });
      if (reconciliation?.type === "thread.session.set") {
        yield* setThreadSession({
          threadId: thread.id,
          session: reconciliation.session,
          createdAt: event.payload.createdAt,
          expectedSessionEpoch: thread.session?.sessionEpoch ?? 0,
          ...(thread.session?.activeTurnId
            ? { expectedActiveTurnId: thread.session.activeTurnId }
            : {}),
        });
      }
      return;
    }

    if (!runtimeSession && event.payload.pendingFlushIntent !== undefined) {
      yield* Effect.sleep("100 millis");
      runtimeSession = yield* providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === thread.id)));
      if (!runtimeSession) {
        const reconciliation = buildThreadReconciliationCommand({
          thread,
          liveSession: undefined,
          occurredAt: event.payload.createdAt,
        });
        if (reconciliation?.type === "thread.session.set") {
          yield* setThreadSession({
            threadId: thread.id,
            session: reconciliation.session,
            createdAt: event.payload.createdAt,
            expectedSessionEpoch: thread.session?.sessionEpoch ?? 0,
            ...(thread.session?.activeTurnId
              ? { expectedActiveTurnId: thread.session.activeTurnId }
              : {}),
          });
        }
        if (event.payload.operation) yield* completeInterruptContinue(event);
        else yield* cancelPendingFlush(event);
        return;
      }
      if (
        event.payload.turnId !== undefined &&
        event.payload.turnId !== runtimeSession.activeTurnId
      ) {
        yield* Effect.logWarning("provider turn interrupt recheck found a newer turn", {
          threadId: thread.id,
          requestedTurnId: event.payload.turnId,
          liveActiveTurnId: runtimeSession.activeTurnId ?? null,
        });
        yield* appendProviderFailureActivity({
          threadId: thread.id,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt preserved a newer turn",
          detail: `The live provider turn changed during settlement (requested=${event.payload.turnId}, live=${runtimeSession.activeTurnId ?? "none"}).`,
          turnId: event.payload.turnId,
          createdAt: event.payload.createdAt,
        });
        yield* cancelPendingFlush(event);
        return;
      }
    }

    let interruptAcknowledged = false;
    yield* providerService
      .interruptTurn({
        threadId: event.payload.threadId,
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
        sessionEpoch: event.payload.operation?.sessionEpoch ?? thread.session?.sessionEpoch ?? 0,
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => (interruptAcknowledged = true))),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const detail = formatProviderServiceCauseDetail(cause);
            yield* appendProviderFailureActivity({
              threadId: thread.id,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail,
              turnId: event.payload.turnId ?? null,
              createdAt: event.payload.createdAt,
            });
            yield* cancelPendingFlush(event);
            if (event.payload.operation) {
              yield* setTurnControlOperation({
                orchestrationEngine,
                threadId: thread.id,
                operation: event.payload.operation,
                state: "failed",
                error: detail,
                createdAt: event.payload.createdAt,
              });
            }
          }),
        ),
      );
    if (!interruptAcknowledged) return;
    if (event.payload.operation) {
      yield* setTurnControlOperation({
        orchestrationEngine,
        threadId: thread.id,
        operation: event.payload.operation,
        state: "waiting-for-settlement",
        createdAt: event.payload.createdAt,
      });
    }
    if (event.payload.pendingFlushIntent !== undefined) {
      yield* settleInterruptAfterAcknowledgement({
        event,
        thread,
        providerService,
        setThreadSession,
      });
      const settledThread = yield* resolveThread(thread.id);
      if (event.payload.operation && settledThread?.session?.activeTurnId == null) {
        yield* completeInterruptContinue(event);
      }
      return;
    }
    // Interrupt acknowledgement only confirms that the provider accepted the
    // request. Keep the projected turn active until runtime ingestion or
    // authoritative reconciliation confirms terminal settlement.
  });

  const {
    processApprovalResponseRequested,
    processSessionStopRequested,
    processUserInputResponseRequested,
  } = makeProcessSessionResponseHandlers({
    providerService,
    orchestrationEngine,
    appendProviderFailureActivity,
    resolveThread,
  });

  return {
    processApprovalResponseRequested,
    processSessionStopRequested,
    processTurnInterruptRequested,
    processUserInputResponseRequested,
  };
};
