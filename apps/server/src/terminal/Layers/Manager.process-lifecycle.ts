import { type TerminalSessionSnapshot } from "@bigbud/contracts";
import { type TerminalEvent } from "@bigbud/contracts";
import { Effect, Fiber, Option, type Scope } from "effect";

import { type PtyAdapterShape, type PtyProcess } from "../Services/PTY";
import { TerminalProcessSignalError, type TerminalSubprocessCheckError } from "./Manager.shell";
import {
  type PendingProcessEvent,
  type TerminalManagerState,
  type TerminalSessionState,
  type TerminalStartInput,
} from "./Manager.types";

// ---------------------------------------------------------------------------
// Context passed in from the factory
// ---------------------------------------------------------------------------

export interface ProcessLifecycleContext {
  modifyManagerState: <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => Effect.Effect<A>;
  readManagerState: Effect.Effect<TerminalManagerState>;
  publishEvent: (event: TerminalEvent) => Effect.Effect<void>;
  evictInactiveSessionsIfNeeded: () => Effect.Effect<void>;
  queuePersist: (threadId: string, terminalId: string, history: string) => Effect.Effect<void>;
  processKillGraceMs: number;
  historyLineLimit: number;
  workerScope: Scope.Closeable;
  runFork: <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, E>;
  // subprocessChecker may fail with TerminalSubprocessCheckError; errors are handled internally
  subprocessChecker: (pid: number) => Effect.Effect<boolean, TerminalSubprocessCheckError>;
  subprocessPollIntervalMs: number;
  shellResolver: () => string;
  ptyAdapter: PtyAdapterShape;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for use in Manager.process.ts cleanup finalizer)
// ---------------------------------------------------------------------------

export function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

export function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

export function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Kill fiber management (exported *With helpers used by Manager.process-drain)
// ---------------------------------------------------------------------------

export function clearKillFiberWith(
  modifyManagerState: ProcessLifecycleContext["modifyManagerState"],
  proc: PtyProcess | null,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!proc) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(proc),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(proc);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  }).pipe(Effect.withSpan("terminal.clearKillFiber"));
}

export function registerKillFiberWith(
  modifyManagerState: ProcessLifecycleContext["modifyManagerState"],
  proc: PtyProcess,
  fiber: Fiber.Fiber<void, never>,
): Effect.Effect<void> {
  return modifyManagerState((state) => {
    const killFibers = new Map(state.killFibers);
    killFibers.set(proc, fiber);
    return [undefined, { ...state, killFibers }] as const;
  }).pipe(Effect.withSpan("terminal.registerKillFiber"));
}

export function runKillEscalationWith(
  processKillGraceMs: number,
  proc: PtyProcess,
  threadId: string,
  terminalId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const terminated = yield* Effect.try({
      try: () => proc.kill("SIGTERM"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          message: "Failed to send SIGTERM to terminal process.",
          cause,
          signal: "SIGTERM",
        }),
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGTERM",
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!terminated) {
      return;
    }

    yield* Effect.sleep(processKillGraceMs);

    yield* Effect.try({
      try: () => proc.kill("SIGKILL"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          message: "Failed to send SIGKILL to terminal process.",
          cause,
          signal: "SIGKILL",
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to force-kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGKILL",
          error: error.message,
        }),
      ),
    );
  }).pipe(Effect.withSpan("terminal.runKillEscalation"));
}

// ---------------------------------------------------------------------------
// Exported function type aliases (consumed by Manager.process-drain)
// ---------------------------------------------------------------------------

export interface ProcessLifecycleFns {
  clearKillFiber: (proc: PtyProcess | null) => Effect.Effect<void>;
  runKillEscalation: (
    proc: PtyProcess,
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<void>;
  stopProcess: (session: TerminalSessionState) => Effect.Effect<void>;
  startSession: (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) => Effect.Effect<void>;
  pollSubprocessActivity: () => Effect.Effect<void>;
}
