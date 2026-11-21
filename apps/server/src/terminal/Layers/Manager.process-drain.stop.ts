import { Effect } from "effect";

import { type PtyProcess } from "../Services/PTY";
import { cleanupProcessHandles, type ProcessLifecycleContext } from "./Manager.process-lifecycle";
import { drainProcessEventsWith } from "./Manager.process-drain.events.ts";
import { confirmTerminalProcessStopped } from "./Manager.process.stop";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import type { TerminalSessionState } from "./Manager.types";
import type { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";

export function cleanupFailedTerminalObserver(
  process: PtyProcess | null,
  kill: (process: PtyProcess) => Effect.Effect<void>,
): Effect.Effect<void> {
  if (!process) return Effect.void;
  if (process.detach)
    return Effect.sync(() => process.detach?.()).pipe(Effect.ignoreCause({ log: true }));
  return kill(process);
}

// ---------------------------------------------------------------------------
// stopProcessWith
// ---------------------------------------------------------------------------

export function stopProcessWith(
  ctx: ProcessLifecycleContext,
  clearKillFiber: (proc: PtyProcess | null) => Effect.Effect<void>,
  session: TerminalSessionState,
): Effect.Effect<void, TerminalExecutionTargetError> {
  return Effect.gen(function* () {
    const process = session.process;
    yield* confirmTerminalProcessStopped(session, ctx.processKillGraceMs);
    if (!process) return;
    yield* ctx.flushPtyOutput(session.threadId, session.terminalId);
    // Preserve trailing diagnostic output before dropping the old process handles.
    yield* drainProcessEventsWith(ctx, clearKillFiber, session, process.pid);

    yield* ctx.modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.remoteShellPid = undefined;
      session.hasRunningSubprocess = false;
      session.activeAgentProvider = null;
      session.activeAgent = null;
      session.agentIdentityMisses = 0;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = nextTerminalTimestamp(session.updatedAt);
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* ctx.evictInactiveSessionsIfNeeded();
  }).pipe(Effect.withSpan("terminal.stopProcess"));
}
