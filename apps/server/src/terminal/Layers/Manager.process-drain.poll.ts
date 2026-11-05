import { Effect, Option } from "effect";
import { invalidateTerminalWorkAssessment } from "./Manager.idleWork.ts";

import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { pollRemoteProcessesWith } from "./Manager.process-drain.remote.ts";
import { toSessionKey } from "./Manager.shell";
import { pollAgentIdentityWith } from "./Manager.process-drain.identity";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import { type TerminalSessionState } from "./Manager.types";

function runningSessionsWith(ctx: ProcessLifecycleContext) {
  return ctx.readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      ),
    ),
  );
}

/** Remote SSH latency must never stall local identity/activity polling. */
export function startProcessPollingWith(ctx: ProcessLifecycleContext): Effect.Effect<void> {
  return Effect.forEach(
    [false, true],
    (remote) =>
      Effect.forever(
        runningSessionsWith(ctx).pipe(
          Effect.flatMap((sessions) =>
            sessions.length === 0
              ? Effect.void
              : remote
                ? pollRemoteProcessesWith(ctx, sessions)
                : pollSubprocessActivityWith(ctx, false),
          ),
          Effect.andThen(Effect.sleep(ctx.subprocessPollIntervalMs)),
        ),
      ).pipe(Effect.forkIn(ctx.workerScope)),
    { discard: true },
  );
}

export function pollSubprocessActivityWith(
  ctx: ProcessLifecycleContext,
  includeRemote = true,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const runningSessions = yield* runningSessionsWith(ctx);

    if (runningSessions.length === 0) {
      return;
    }

    const checkSubprocessActivity = (
      session: TerminalSessionState & { pid: number },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const terminalPid = session.pid;
        const runtimeEpoch = session.runtimeEpoch;
        const runtimeGeneration = session.runtimeGeneration;
        const executionTargetId = session.executionTargetId;
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
          yield* invalidateTerminalWorkAssessment(ctx, [
            {
              threadId: session.threadId,
              terminalId: session.terminalId,
              runtimeGeneration,
              runtimeEpoch,
              executionTargetId,
              pid: terminalPid,
            },
          ]);
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
            liveSession.value.runtimeEpoch !== runtimeEpoch ||
            liveSession.value.runtimeGeneration !== runtimeGeneration ||
            liveSession.value.executionTargetId !== executionTargetId
          ) {
            return [Option.none(), managerState] as const;
          }

          liveSession.value.subprocessAssessedGeneration = runtimeGeneration;
          liveSession.value.subprocessAssessedEpoch = runtimeEpoch;
          if (liveSession.value.hasRunningSubprocess === hasRunningSubprocess.value) {
            return [Option.none(), managerState] as const;
          }
          liveSession.value.hasRunningSubprocess = hasRunningSubprocess.value;
          liveSession.value.updatedAt = nextTerminalTimestamp(liveSession.value.updatedAt);

          return [
            Option.some({
              type: "activity" as const,
              threadId: liveSession.value.threadId,
              terminalId: liveSession.value.terminalId,
              createdAt: liveSession.value.updatedAt,
              hasRunningSubprocess: hasRunningSubprocess.value,
            }),
            managerState,
          ] as const;
        });

        if (Option.isSome(event)) {
          yield* ctx.publishEvent(event.value);
        }
      }).pipe(Effect.withSpan("terminal.checkSubprocessActivity"));

    yield* Effect.all(
      [
        pollAgentIdentityWith(ctx, runningSessions),
        includeRemote ? pollRemoteProcessesWith(ctx, runningSessions) : Effect.void,
        Effect.forEach(
          runningSessions.filter(
            (session) =>
              isLocalExecutionTarget(session.executionTargetId) ||
              isWslTerminalTargetId(session.executionTargetId),
          ),
          checkSubprocessActivity,
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
      ],
      { concurrency: 3, discard: true },
    );
    yield* ctx.refreshIdleWork ?? Effect.void;
  }).pipe(Effect.withSpan("terminal.pollSubprocessActivity"));
}
