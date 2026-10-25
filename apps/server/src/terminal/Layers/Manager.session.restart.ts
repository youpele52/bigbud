import * as Effect from "effect/Effect";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionState } from "./Manager.types";

/** Never replace an owned remote process until its adapter proves durable termination. */
export const prepareTerminalRestart = Effect.fn("terminal.prepareRestart")(function* (
  session: TerminalSessionState,
) {
  const prepareRestart = session.restartPreparation ?? session.process?.prepareRestart;
  if (!prepareRestart) return;
  // Retain the fence even if a late exit clears session.process after a timeout.
  session.restartPreparation = prepareRestart;
  session.restartPending = true;
  yield* Effect.tryPromise({
    try: prepareRestart,
    catch: (cause) =>
      new TerminalExecutionTargetError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        executionTargetId: session.executionTargetId,
        detail:
          cause instanceof Error
            ? cause.message
            : "Remote terminal termination is uncertain; no replacement was started.",
        cause,
      }),
  }).pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        session.status = "error";
        session.historyUnavailable = true;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        session.restartPending = false;
      }),
    ),
  );
  session.restartPreparation = undefined;
});
