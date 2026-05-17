import { Effect, Option } from "effect";

import { toSessionKey } from "./Manager.shell";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import { type TerminalSessionState } from "./Manager.types";

export function pollSubprocessActivityWith(ctx: ProcessLifecycleContext): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* ctx.readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return;
    }

    const checkSubprocessActivity = (
      session: TerminalSessionState & { pid: number },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const terminalPid = session.pid;
        const hasRunningSubprocess = yield* ctx.subprocessChecker(terminalPid).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as(Option.none<boolean>())),
          ),
        );

        if (Option.isNone(hasRunningSubprocess)) {
          return;
        }

        const event = yield* ctx.modifyManagerState((managerState) => {
          const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
            managerState.sessions.get(toSessionKey(session.threadId, session.terminalId)),
          );
          if (
            Option.isNone(liveSession) ||
            liveSession.value.status !== "running" ||
            liveSession.value.pid !== terminalPid ||
            liveSession.value.hasRunningSubprocess === hasRunningSubprocess.value
          ) {
            return [Option.none(), managerState] as const;
          }

          liveSession.value.hasRunningSubprocess = hasRunningSubprocess.value;
          liveSession.value.updatedAt = new Date().toISOString();

          return [
            Option.some({
              type: "activity" as const,
              threadId: liveSession.value.threadId,
              terminalId: liveSession.value.terminalId,
              createdAt: new Date().toISOString(),
              hasRunningSubprocess: hasRunningSubprocess.value,
            }),
            managerState,
          ] as const;
        });

        if (Option.isSome(event)) {
          yield* ctx.publishEvent(event.value);
        }
      }).pipe(Effect.withSpan("terminal.checkSubprocessActivity"));

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
  }).pipe(Effect.withSpan("terminal.pollSubprocessActivity"));
}
