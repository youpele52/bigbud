/**
 * OpencodeAdapter session — session lifecycle factory.
 *
 * Composes `startSession` with turn and query/stop method groups.
 * Sub-modules:
 *   - OpencodeAdapter.session.helpers  — pure utility functions
 *   - OpencodeAdapter.session.turn     — sendTurn, interruptTurn, respondToRequest, respondToUserInput
 *   - OpencodeAdapter.session.query    — stopSession, listSessions, hasSession, readThread, rollbackThread, stopAll
 *
 * @module OpencodeAdapter.session
 */
import {
  ApprovalRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type EventId,
} from "@bigbud/contracts";
import { Effect, Queue, ServiceMap } from "effect";

import { ProviderAdapterSessionNotFoundError } from "../../Errors.ts";
import type { OpencodeServerManagerShape } from "../../Services/Opencode/ServerManager.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import {
  FULL_ACCESS_AUTO_APPROVE_AFTER_MS,
  makeHandleEvent,
  makeSyntheticEventFn,
} from "./Adapter.stream.ts";
import { makeTurnMethods } from "./Adapter.session.turn.ts";
import { makeQueryMethods, makeStopSessionRecord } from "./Adapter.session.query.ts";
import { makeStartSession } from "./Adapter.session.start.ts";

// ── Shared dep interfaces (used by sub-modules) ───────────────────────

/** Deps required by turn methods. */
export interface TurnMethodDeps {
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActiveOpencodeSession, ProviderAdapterSessionNotFoundError>;
  readonly syntheticEventFn: ReturnType<typeof makeSyntheticEventFn>;
  readonly emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  readonly teardownSessionRecord: (record: ActiveOpencodeSession) => Effect.Effect<void>;
  readonly serverConfig: { readonly attachmentsDir: string };
}

/** Deps required by query/stop methods. */
export interface QueryMethodDeps {
  readonly sessions: Map<ThreadId, ActiveOpencodeSession>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActiveOpencodeSession, ProviderAdapterSessionNotFoundError>;
  readonly syntheticEventFn: ReturnType<typeof makeSyntheticEventFn>;
  readonly emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
}

// ── Top-level deps ────────────────────────────────────────────────────

export interface SessionMethodDeps {
  readonly sessions: Map<ThreadId, ActiveOpencodeSession>;
  readonly runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>;
  readonly serverManager: OpencodeServerManagerShape;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  readonly serverConfig: { readonly attachmentsDir: string };
  readonly nextEventId: Effect.Effect<EventId>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly services: ServiceMap.ServiceMap<never>;
}

// ── Factory ───────────────────────────────────────────────────────────

export function makeSessionMethods(deps: SessionMethodDeps) {
  const {
    sessions,
    runtimeEventQueue,
    serverManager,
    serverSettings,
    serverConfig,
    nextEventId,
    makeEventStamp,
    nativeEventLogger,
    services,
  } = deps;

  const emitFn = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    Queue.offerAll(runtimeEventQueue, events).pipe(Effect.asVoid);

  const syntheticEventFn = makeSyntheticEventFn(nextEventId, makeEventStamp);
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActiveOpencodeSession, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const queryDeps = {
    sessions,
    requireSession,
    syntheticEventFn,
    emitFn,
  } satisfies QueryMethodDeps;

  const stopSessionRecord = makeStopSessionRecord(sessions);
  const teardownSessionRecord = (record: ActiveOpencodeSession) =>
    stopSessionRecord(record).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          record.sseAbortController?.abort();
          record.sseAbortController = null;
          record.pendingPermissions.clear();
          record.pendingUserInputs.clear();
          sessions.delete(record.threadId);
        }),
      ),
    );

  const turnMethodDeps: TurnMethodDeps = {
    requireSession,
    syntheticEventFn,
    emitFn,
    teardownSessionRecord,
    serverConfig,
  };

  const turnMethodsWithRecovery = makeTurnMethods(turnMethodDeps);

  const autoApprovePendingPermission = (session: ActiveOpencodeSession, requestId: string) =>
    Effect.gen(function* () {
      yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
      const pending = session.pendingPermissions.get(requestId);
      if (!pending || pending.responding) {
        return;
      }
      yield* turnMethodsWithRecovery.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId),
        "accept",
      );
    }).pipe(
      // On failure, emit a synthetic request.resolved(cancel) so the client
      // dialog closes and the agent doesn't get stuck waiting for an approval
      // that will never arrive.
      Effect.catch((error) =>
        Effect.gen(function* () {
          console.error(
            `[opencode-adapter] failed to auto-approve permission request '${requestId}' for thread=${session.threadId} session=${session.opencodeSessionId}:`,
            error,
          );
          const pending = session.pendingPermissions.get(requestId);
          if (!pending || pending.responding) {
            return;
          }
          // Mark as responding to prevent a duplicate from the manual path.
          pending.responding = true;
          session.pendingPermissions.delete(requestId);
          const cancelEvent = yield* syntheticEventFn(
            session.threadId,
            "request.resolved",
            { requestType: pending.requestType, decision: "cancel" },
            {
              ...(pending.turnId ? { turnId: pending.turnId } : {}),
              requestId,
            },
          );
          yield* emitFn([cancelEvent]);
        }),
      ),
    );

  const scheduleAutoApprovePendingPermission = (
    session: ActiveOpencodeSession,
    requestId: string,
  ): void => {
    void autoApprovePendingPermission(session, requestId)
      .pipe(Effect.runPromiseWith(services))
      .catch((error) => {
        // catchAll above should handle all Effect errors; this catch is a
        // last-resort safety net for unexpected thrown rejections.
        console.error(
          `[opencode-adapter] unexpected rejection during auto-approve for '${requestId}':`,
          error,
        );
      });
  };

  const handleEventFn = makeHandleEvent(
    nextEventId,
    makeEventStamp,
    nativeEventLogger,
    emitFn,
    scheduleAutoApprovePendingPermission,
  );

  // ── startSession ──────────────────────────────────────────────────

  const startSession = makeStartSession({
    sessions,
    serverManager,
    serverSettings,
    emitFn,
    handleEventFn,
    syntheticEventFn,
    services,
  });

  // ── Compose all methods ───────────────────────────────────────────

  const queryMethods = makeQueryMethods(queryDeps);

  return {
    startSession,
    ...turnMethodsWithRecovery,
    ...queryMethods,
  };
}

// Re-export ProviderSendTurnInput for downstream consumers that previously
// imported it from this module via the session types.
export type { ProviderSendTurnInput };
