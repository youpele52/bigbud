import { Effect } from "effect";

import { capHistory, sanitizeTerminalHistoryChunk } from "./Manager.history";
import { cleanupProcessHandles, type ProcessLifecycleContext } from "./Manager.process-lifecycle";
import type { PtyProcess } from "../Services/PTY";
import type { TerminalSessionState } from "./Manager.types";

export function drainProcessEventsWith(
  ctx: ProcessLifecycleContext,
  clearKillFiber: (proc: PtyProcess | null) => Effect.Effect<void>,
  session: TerminalSessionState,
  expectedPid: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const action = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          let combinedData = nextEvent.data;
          while (session.pendingProcessEventIndex < session.pendingProcessEvents.length) {
            const pendingEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
            if (!pendingEvent || pendingEvent.type !== "output") {
              break;
            }
            combinedData += pendingEvent.data;
            session.pendingProcessEventIndex += 1;
          }
          if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
          }

          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            combinedData,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history = capHistory(
              `${session.history}${sanitized.visibleText}`,
              ctx.historyLineLimit,
            );
          }
          session.updatedAt = new Date().toISOString();

          return {
            type: "output",
            threadId: session.threadId,
            terminalId: session.terminalId,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: combinedData,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        session.updatedAt = new Date().toISOString();

        return {
          type: "exit",
          process,
          threadId: session.threadId,
          terminalId: session.terminalId,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* ctx.queuePersist(action.threadId, action.terminalId, action.history);
        }
        yield* ctx.publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          data: action.data,
          createdAt: new Date().toISOString(),
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* ctx.publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
        createdAt: new Date().toISOString(),
      });
      yield* ctx.evictInactiveSessionsIfNeeded();
      return;
    }
  }).pipe(Effect.withSpan("terminal.drainProcessEvents"));
}
