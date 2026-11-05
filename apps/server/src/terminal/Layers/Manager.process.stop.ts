import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionState } from "./Manager.types";
import { prepareTerminalRestart } from "./Manager.session.restart";

/** Observe exit before signaling; a successful signal is not a stopped process. */
export const confirmTerminalProcessStopped = Effect.fn("terminal.confirmStopped")(function* (
  session: TerminalSessionState,
  graceMs: number,
) {
  session.stopPending = true;
  return yield* Effect.gen(function* () {
    // Remote owners require definitive exit AND durable owner release, including retries.
    yield* prepareTerminalRestart(session);
    const process = session.process;
    if (!process || process.prepareRestart) return;
    const error = (detail: string, cause?: unknown) =>
      new TerminalExecutionTargetError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        executionTargetId: session.executionTargetId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const exited = Deferred.makeUnsafe<void>();
    const unsubscribe = yield* Effect.try({
      try: () =>
        process.onExit((event) => {
          session.observedExit = { process, event };
          Deferred.doneUnsafe(exited, Effect.void);
        }),
      catch: (cause) =>
        error("Could not observe terminal shutdown; no replacement was started.", cause),
    });
    return yield* Effect.gen(function* () {
      // Exit may already have been observed while its asynchronous drain was still pending.
      if (session.observedExit?.process === process) return;
      // A flow-controlled PTY must drain to deliver its exit event. This does not change its size.
      yield* Effect.try({
        try: () => process.resume?.(),
        catch: (cause) => error("Could not resume terminal output for shutdown.", cause),
      });
      const signal = (name: string) =>
        Effect.try({
          try: () => process.kill(name),
          catch: (cause) => error(`Could not send ${name} to terminal.`, cause),
        }).pipe(
          Effect.catch((cause) =>
            // A concurrent natural exit can make signaling throw even though shutdown succeeded.
            Deferred.isDone(exited).pipe(
              Effect.flatMap((done) =>
                done
                  ? Effect.void
                  : Effect.fail(error(`Could not send ${name} to terminal.`, cause)),
              ),
            ),
          ),
        );
      yield* signal("SIGTERM");
      const graceful = yield* Deferred.await(exited).pipe(Effect.timeoutOption(graceMs));
      if (Option.isSome(graceful)) return;
      yield* signal("SIGKILL");
      const forced = yield* Deferred.await(exited).pipe(
        Effect.timeoutOption(Math.max(graceMs, 1_000)),
      );
      if (Option.isNone(forced)) {
        return yield* error(
          "Terminal shutdown is unconfirmed; its process is still tracked and no replacement was started. Retry after checking the terminal.",
        );
      }
    }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        session.stopPending = false;
        if (session.process && session.observedExit?.process !== session.process) {
          try {
            session.reconcileOutputHold?.();
          } catch {
            // Preserve the original shutdown failure if the native descriptor also closed.
          }
        }
      }),
    ),
  );
});
