import { Effect } from "effect";
import { cleanupProcessHandles, runKillEscalationWith } from "./Manager.process-lifecycle.ts";
import type { TerminalSessionState } from "./Manager.types.ts";
import type { PtyProcess } from "../Services/PTY.ts";

export const cleanupTerminalSessions = Effect.fn("terminal.cleanupSessions")(function* (input: {
  readonly sessions: ReadonlyArray<TerminalSessionState>;
  readonly processKillGraceMs: number;
  readonly clearKillFiber: (process: PtyProcess) => Effect.Effect<void>;
  readonly releaseWorktreeLease: (input: {
    threadId: string;
    terminalId: string;
  }) => Effect.Effect<void>;
}) {
  yield* Effect.forEach(
    input.sessions,
    (session) =>
      Effect.gen(function* () {
        cleanupProcessHandles(session);
        if (!session.process) return;
        if (session.process.detach) {
          session.process.detach();
          return;
        }
        yield* input.clearKillFiber(session.process);
        yield* runKillEscalationWith(
          input.processKillGraceMs,
          session.process,
          session.threadId,
          session.terminalId,
        );
        yield* input.releaseWorktreeLease({
          threadId: session.threadId,
          terminalId: session.terminalId,
        });
      }),
    { concurrency: "unbounded", discard: true },
  );
});
