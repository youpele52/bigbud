import {
  assertDirectShellCloseAvailable,
  assertDirectShellThreadCloseAvailable,
} from "./Manager.shell.direct.policy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { toSessionKey } from "./Manager.shell";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";
import { assertTerminalGeneration } from "./Manager.session.generation";

export function makeTerminalClose(ctx: SessionApiContext): TerminalManagerShape["close"] {
  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
    expectedGeneration?: string,
    onlyIfNotRunning = false,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* ctx.getSession(threadId, terminalId);
    if (Option.isSome(session)) yield* assertTerminalGeneration(session.value, expectedGeneration);
    yield* assertDirectShellCloseAvailable(
      ctx.directShellOwners,
      {
        threadId,
        terminalId,
        executionTargetId: Option.isSome(session) ? session.value.executionTargetId : "unknown",
      },
      Option.getOrUndefined(session),
    );
    // A recovered remote owner can outlive the server session map. History is its existing
    // recovery marker; do not discard it or its lease while shutdown identity is unknown.
    if (
      Option.isNone(session) &&
      (onlyIfNotRunning || expectedGeneration !== undefined) &&
      (yield* ctx.historyExists(threadId, terminalId))
    ) {
      return yield* new TerminalExecutionTargetError({
        threadId,
        terminalId,
        executionTargetId: "unknown",
        detail:
          "Previous terminal ownership has not been recovered. Reconnect to its original target before closing it; its history was retained.",
      });
    }
    if (Option.isSome(session)) {
      if (
        session.value.remoteOwnerRecoveryRequired ||
        (onlyIfNotRunning && (session.value.process || session.value.restartPreparation))
      ) {
        return yield* new TerminalExecutionTargetError({
          threadId,
          terminalId,
          executionTargetId: session.value.executionTargetId,
          detail:
            "Terminal ownership is unresolved or its identity is unavailable. Reconnect before closing it; a process may still be running.",
        });
      }
      yield* ctx.flushPtyOutput(threadId, terminalId);
      yield* ctx.stopProcess(session.value);
      yield* ctx.persistHistory(threadId, terminalId, session.value.history);
    }
    yield* ctx.releaseWorktreeLease({ threadId, terminalId });
    yield* ctx.flushPersist(threadId, terminalId);
    yield* ctx.modifyManagerState((state) => {
      if (!state.sessions.has(key)) return [undefined, state] as const;
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [undefined, { ...state, sessions }] as const;
    });
    if (deleteHistory) yield* ctx.deleteHistory(threadId, terminalId);
  });
  return (input) =>
    ctx.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.onlyIfNotRunning && !input.terminalId) {
          return yield* new TerminalExecutionTargetError({
            threadId: input.threadId,
            terminalId: "unknown",
            executionTargetId: "unknown",
            detail:
              "A terminal ID is required to confirm that an unidentified terminal is stopped.",
          });
        }
        if (input.terminalId) {
          yield* closeSession(
            input.threadId,
            input.terminalId,
            input.deleteHistory === true,
            input.expectedGeneration,
            input.onlyIfNotRunning,
          );
          return;
        }
        yield* assertDirectShellThreadCloseAvailable(ctx.directShellOwners, input.threadId);
        const sessions = yield* ctx.sessionsForThread(input.threadId);
        yield* Effect.forEach(
          sessions,
          (session) =>
            closeSession(
              input.threadId,
              session.terminalId,
              false,
              input.expectedGeneration,
              input.onlyIfNotRunning,
            ),
          { discard: true },
        );
        if (input.deleteHistory) yield* ctx.deleteAllHistoryForThread(input.threadId);
      }),
    );
}
