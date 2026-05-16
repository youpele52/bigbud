import { type ProviderSession, type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import type { PiAdapterShape } from "../../Services/Pi/Adapter.ts";
import { buildResumeCursor } from "./Adapter.session.helpers.ts";
import type { ActivePiSession, PiEmitEvents, PiSyntheticEventFn } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { buildThreadSnapshot } from "./Adapter.utils.ts";

export function makePiSessionControlMethods(deps: {
  readonly emit: PiEmitEvents;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly sessions: Map<ThreadId, ActivePiSession>;
  readonly stopSessionRecord: (session: ActivePiSession) => Effect.Effect<void>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActivePiSession, ProviderAdapterSessionNotFoundError>;
}) {
  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
    const session = yield* deps.requireSession(threadId);
    deps.sessions.delete(threadId);
    yield* deps.stopSessionRecord(session);
    yield* deps.emit([
      yield* deps.makeSyntheticEvent(threadId, "session.state.changed", {
        state: "stopped",
        reason: "session.stopped",
      }),
      yield* deps.makeSyntheticEvent(threadId, "session.exited", {
        reason: "session.stopped",
        recoverable: true,
        exitKind: "graceful",
      }),
    ]);
  });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      [...deps.sessions.values()].map(
        (session) =>
          Object.assign(
            {
              provider: PROVIDER,
              status: session.activeTurnId ? "running" : "ready",
              runtimeMode: session.runtimeMode,
              providerRuntimeExecutionTargetId: session.providerRuntimeExecutionTargetId,
              workspaceExecutionTargetId: session.workspaceExecutionTargetId,
              executionTargetId: session.executionTargetId,
              threadId: session.threadId,
              resumeCursor: buildResumeCursor(session),
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
            session.cwd ? { cwd: session.cwd } : {},
            session.model ? { model: session.model } : {},
            session.activeTurnId ? { activeTurnId: session.activeTurnId } : {},
            session.lastError ? { lastError: session.lastError } : {},
          ) satisfies ProviderSession,
      ),
    );

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(deps.sessions.has(threadId));

  const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const session = yield* deps.requireSession(threadId);
    return buildThreadSnapshot(session);
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "Pi sessions do not support rolling back conversation state.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

  const stopAll: PiAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
    yield* Effect.forEach(
      Array.from(deps.sessions.values()),
      (session) =>
        Effect.gen(function* () {
          deps.sessions.delete(session.threadId);
          yield* deps.stopSessionRecord(session);
          yield* deps.emit([
            yield* deps.makeSyntheticEvent(session.threadId, "session.state.changed", {
              state: "stopped",
              reason: "session.stopped",
            }),
            yield* deps.makeSyntheticEvent(session.threadId, "session.exited", {
              reason: "session.stopped",
              recoverable: true,
              exitKind: "graceful",
            }),
          ]);
        }),
      { concurrency: "unbounded" },
    );
  });

  return {
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  } satisfies Pick<
    PiAdapterShape,
    "stopSession" | "listSessions" | "hasSession" | "readThread" | "rollbackThread" | "stopAll"
  >;
}
