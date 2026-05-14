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
  type ProviderSession,
  type EventId,
} from "@bigbud/contracts";
import { Effect, Queue, ServiceMap } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import type { OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import type { OpencodeServerManagerShape } from "../../Services/Opencode/ServerManager.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import {
  FULL_ACCESS_AUTO_APPROVE_AFTER_MS,
  makeHandleEvent,
  makeSyntheticEventFn,
  startEventStream,
  toMessage,
} from "./Adapter.stream.ts";
import { isOpencodeModelSelection, resolveProviderIDForModel } from "./Adapter.session.helpers.ts";
import { makeTurnMethods } from "./Adapter.session.turn.ts";
import { makeQueryMethods } from "./Adapter.session.query.ts";

// ── Shared dep interfaces (used by sub-modules) ───────────────────────

/** Deps required by turn methods. */
export interface TurnMethodDeps {
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActiveOpencodeSession, ProviderAdapterSessionNotFoundError>;
  readonly syntheticEventFn: ReturnType<typeof makeSyntheticEventFn>;
  readonly emitFn: (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;
  readonly serverConfig: { readonly attachmentsDir: string };
}

/** Deps required by query/stop methods. */
export interface QueryMethodDeps extends TurnMethodDeps {
  readonly sessions: Map<ThreadId, ActiveOpencodeSession>;
}

// ── Top-level deps ────────────────────────────────────────────────────

export interface SessionMethodDeps {
  readonly sessions: Map<ThreadId, ActiveOpencodeSession>;
  readonly runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>;
  readonly serverManager: OpencodeServerManagerShape;
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

  const sharedDeps: QueryMethodDeps = {
    sessions,
    requireSession,
    syntheticEventFn,
    emitFn,
    serverConfig,
  };

  const turnMethods = makeTurnMethods(sharedDeps);

  const autoApprovePendingPermission = (session: ActiveOpencodeSession, requestId: string) =>
    Effect.gen(function* () {
      yield* Effect.sleep(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
      const pending = session.pendingPermissions.get(requestId);
      if (!pending || pending.responding) {
        return;
      }
      yield* turnMethods.respondToRequest(
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

  const startSession: OpencodeAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing) {
        return {
          provider: PROVIDER,
          status: existing.activeTurnId ? "running" : "ready",
          runtimeMode: existing.runtimeMode,
          threadId: input.threadId,
          ...(existing.cwd ? { cwd: existing.cwd } : {}),
          ...(existing.model ? { model: existing.model } : {}),
          resumeCursor: { sessionId: existing.opencodeSessionId },
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          ...(existing.lastError ? { lastError: existing.lastError } : {}),
        } satisfies ProviderSession;
      }

      // Acquire a handle from the shared OpenCode server manager
      const serverHandle = yield* Effect.tryPromise({
        try: () => serverManager.acquire(input.cwd),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start OpenCode server."),
            cause,
          }),
      });
      const client = serverHandle.client;

      // Determine model to use
      let modelID: string | undefined;
      let providerID: string | undefined;
      if (isOpencodeModelSelection(input.modelSelection)) {
        modelID = input.modelSelection.model;
        const selectionProviderID =
          "subProviderID" in input.modelSelection
            ? (input.modelSelection as { subProviderID?: string }).subProviderID
            : undefined;
        providerID =
          selectionProviderID ??
          (yield* Effect.tryPromise({
            try: () => resolveProviderIDForModel(client, modelID!),
            catch: () => undefined as never,
          }).pipe(Effect.orElseSucceed(() => undefined)));
      }

      // Create an OpenCode session
      const sessionResp = yield* Effect.tryPromise({
        try: () =>
          client.session.create(input.cwd ? { title: `bigbud session in ${input.cwd}` } : {}),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to create OpenCode session."),
            cause,
          }),
      });

      if (sessionResp.error || !sessionResp.data) {
        serverHandle.release();
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: `Failed to create OpenCode session: ${String(sessionResp.error)}`,
        });
      }

      const opencodeSessionId = sessionResp.data.id;
      const createdAt = new Date().toISOString();

      const record: ActiveOpencodeSession = {
        client,
        releaseServer: () => serverHandle.release(),
        opencodeSessionId,
        threadId: input.threadId,
        createdAt,
        runtimeMode: input.runtimeMode,
        pendingPermissions: new Map(),
        pendingUserInputs: new Map(),
        turns: [],
        sseAbortController: null,
        cwd: input.cwd,
        model: modelID,
        providerID,
        updatedAt: createdAt,
        lastError: undefined,
        activeTurnId: undefined,
        lastUsage: undefined,
        wasRetrying: false,
        reasoningPartIds: new Set(),
      };

      sessions.set(input.threadId, record);

      // Start the SSE event stream
      startEventStream(record, handleEventFn, syntheticEventFn, emitFn, services);

      yield* emitFn([
        yield* syntheticEventFn(
          input.threadId,
          "session.started",
          input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        ),
        yield* syntheticEventFn(input.threadId, "thread.started", {
          providerThreadId: opencodeSessionId,
        }),
        yield* syntheticEventFn(input.threadId, "session.state.changed", {
          state: "ready",
          reason: "session.started",
        }),
      ]);

      return {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelID ? { model: modelID } : {}),
        resumeCursor: { sessionId: opencodeSessionId },
        createdAt,
        updatedAt: createdAt,
      } satisfies ProviderSession;
    });

  // ── Compose all methods ───────────────────────────────────────────

  const queryMethods = makeQueryMethods(sharedDeps);

  return {
    startSession,
    ...turnMethods,
    ...queryMethods,
  };
}

// Re-export ProviderSendTurnInput for downstream consumers that previously
// imported it from this module via the session types.
export type { ProviderSendTurnInput };
