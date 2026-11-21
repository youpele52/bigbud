import { makeKeyedCoalescingWorker } from "@bigbud/shared/KeyedCoalescingWorker";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { PtyProcess } from "../Services/PTY";
import { toSessionKey } from "./Manager.shell";
import {
  enqueueProcessEvent,
  registerKillFiberWith,
  runKillEscalationWith,
  type ProcessLifecycleContext,
} from "./Manager.process-lifecycle";
import type { TerminalSessionState } from "./Manager.types";

export const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (input: {
  readonly lifecycleCtx: Pick<ProcessLifecycleContext, "modifyManagerState">;
  readonly processKillGraceMs: number;
  readonly workerScope: Scope.Closeable;
  readonly proc: PtyProcess;
  readonly threadId: string;
  readonly terminalId: string;
}) {
  const fiber = yield* runKillEscalationWith(
    input.processKillGraceMs,
    input.proc,
    input.threadId,
    input.terminalId,
  ).pipe(
    Effect.ensuring(
      input.lifecycleCtx.modifyManagerState((state) => {
        if (!state.killFibers.has(input.proc)) {
          return [undefined, state] as const;
        }
        const killFibers = new Map(state.killFibers);
        killFibers.delete(input.proc);
        return [undefined, { ...state, killFibers }] as const;
      }),
    ),
    Effect.forkIn(input.workerScope),
  );
  yield* registerKillFiberWith(input.lifecycleCtx.modifyManagerState, input.proc, fiber);
});

/**
 * Per-session coalescing of PTY output into the ordered process-event drain. `drain` is
 * resolved lazily, because the drain itself depends on the queue through the lifecycle context.
 */
export const makeTerminalPtyOutputQueue = Effect.fn("terminal.makePtyOutputQueue")(
  function* (input: {
    readonly runFork: ProcessLifecycleContext["runFork"];
    readonly drain: (session: TerminalSessionState, expectedPid: number) => Effect.Effect<void>;
  }) {
    const worker = yield* makeKeyedCoalescingWorker<
      string,
      {
        readonly session: TerminalSessionState;
        readonly expectedPid: number;
        readonly data: string;
      },
      never,
      never
    >({
      merge: (current, next) => ({
        session: current.session,
        expectedPid: current.expectedPid,
        data: `${current.data}${next.data}`,
      }),
      process: (_sessionKey, request) =>
        Effect.sync(() => {
          if (
            !enqueueProcessEvent(request.session, request.expectedPid, {
              type: "output",
              data: request.data,
            })
          ) {
            return;
          }
          input.runFork(input.drain(request.session, request.expectedPid));
        }),
    });

    const queuePtyOutput = Effect.fn("terminal.queuePtyOutput")(function* (
      session: TerminalSessionState,
      expectedPid: number,
      data: string,
    ) {
      yield* worker.enqueue(toSessionKey(session.threadId, session.terminalId), {
        session,
        expectedPid,
        data,
      });
    });

    const flushPtyOutput = Effect.fn("terminal.flushPtyOutput")(function* (
      threadId: string,
      terminalId: string,
    ) {
      yield* worker.drainKey(toSessionKey(threadId, terminalId));
    });

    return { queuePtyOutput, flushPtyOutput };
  },
);
