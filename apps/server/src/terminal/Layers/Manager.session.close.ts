import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { toSessionKey } from "./Manager.shell";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";

export function makeTerminalClose(ctx: SessionApiContext): TerminalManagerShape["close"] {
  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* ctx.getSession(threadId, terminalId);
    if (Option.isSome(session)) {
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
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }
        const sessions = yield* ctx.sessionsForThread(input.threadId);
        yield* Effect.forEach(
          sessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );
        if (input.deleteHistory) yield* ctx.deleteAllHistoryForThread(input.threadId);
      }),
    );
}
