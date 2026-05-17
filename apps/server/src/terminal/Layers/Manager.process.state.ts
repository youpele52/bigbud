import { Effect, FileSystem, Option, SynchronizedRef } from "effect";

import { TerminalCwdError, TerminalSessionLookupError } from "../Services/Manager";
import {
  deleteAllHistoryForThread as ioDeleteAllHistoryForThread,
  deleteHistory as ioDeleteHistory,
  readHistory as ioReadHistory,
} from "./Manager.history-io";
import { toSessionKey } from "./Manager.shell";
import { type TerminalManagerState, type TerminalSessionState } from "./Manager.types";

export const makeManagerStateAccessors = (
  managerStateRef: SynchronizedRef.SynchronizedRef<TerminalManagerState>,
) => {
  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Option.match(session, {
        onNone: () =>
          Effect.fail(
            new TerminalSessionLookupError({
              threadId,
              terminalId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  return {
    readManagerState,
    modifyManagerState,
    getSession,
    requireSession,
    sessionsForThread,
  };
};

export const makeHistoryAccessors = (input: {
  readonly logsDir: string;
  readonly historyLineLimit: number;
  readonly fileSystem: FileSystem.FileSystem;
}) => ({
  readHistory: (threadId: string, terminalId: string): Effect.Effect<string> =>
    ioReadHistory(input.logsDir, input.historyLineLimit, threadId, terminalId).pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
      Effect.orDie,
    ),
  deleteHistory: (threadId: string, terminalId: string): Effect.Effect<void> =>
    ioDeleteHistory(input.logsDir, threadId, terminalId).pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    ),
  deleteAllHistoryForThread: (threadId: string): Effect.Effect<void> =>
    ioDeleteAllHistoryForThread(input.logsDir, threadId).pipe(
      Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    ),
});

export const makeAssertValidCwd =
  (fileSystem: FileSystem.FileSystem) =>
  (cwd: string): Effect.Effect<void, TerminalCwdError> =>
    Effect.gen(function* () {
      const stats = yield* fileSystem.stat(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalCwdError({
              cwd,
              reason: cause.reason._tag === "NotFound" ? "notFound" : "statFailed",
              cause,
            }),
        ),
      );
      if (stats.type !== "Directory") {
        return yield* new TerminalCwdError({
          cwd,
          reason: "notDirectory",
        });
      }
    }).pipe(Effect.withSpan("terminal.assertValidCwd"));
