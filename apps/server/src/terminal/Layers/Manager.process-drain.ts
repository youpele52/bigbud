import { type TerminalSessionSnapshot } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { increment, terminalSessionsTotal } from "../../observability/Metrics";
import { PtySpawnError, type PtyProcess } from "../Services/PTY";
import { capHistory, sanitizeTerminalHistoryChunk } from "./Manager.history";
import {
  createTerminalSpawnEnv,
  formatShellCandidate,
  isRetryableShellSpawnError,
  resolveShellCandidates,
  toSessionKey,
} from "./Manager.shell";
import {
  cleanupProcessHandles,
  enqueueProcessEvent,
  type ProcessLifecycleContext,
} from "./Manager.process-lifecycle";
import { type TerminalSessionState, type TerminalStartInput } from "./Manager.types";

// ---------------------------------------------------------------------------
// drainProcessEventsWith
// ---------------------------------------------------------------------------

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
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
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
            data: nextEvent.data,
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
          createdAt: new Date().toISOString(),
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* ctx.publishEvent({
        type: "exited",
        threadId: action.threadId,
        terminalId: action.terminalId,
        createdAt: new Date().toISOString(),
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* ctx.evictInactiveSessionsIfNeeded();
      return;
    }
  }).pipe(Effect.withSpan("terminal.drainProcessEvents"));
}

// ---------------------------------------------------------------------------
// trySpawnWith
// ---------------------------------------------------------------------------

export function trySpawnWith(
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  shellCandidates: ReadonlyArray<{ shell: string; args?: string[] }>,
  spawnEnv: NodeJS.ProcessEnv,
  index = 0,
  lastError: PtySpawnError | null = null,
): Effect.Effect<{ process: PtyProcess; shellLabel: string }, PtySpawnError> {
  return Effect.gen(function* () {
    if (index >= shellCandidates.length) {
      const detail = lastError?.message ?? "Failed to spawn PTY process";
      const tried =
        shellCandidates.length > 0
          ? ` Tried shells: ${shellCandidates.map((c) => formatShellCandidate(c)).join(", ")}.`
          : "";
      return yield* new PtySpawnError({
        adapter: "terminal-manager",
        message: `${detail}.${tried}`.trim(),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtySpawnError({
            adapter: "terminal-manager",
            message: "No shell candidate available for PTY spawn.",
          })
      );
    }

    const attempt = yield* Effect.result(
      ctx.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawnWith(ctx, session, shellCandidates, spawnEnv, index + 1, spawnError);
  });
}

// ---------------------------------------------------------------------------
// stopProcessWith
// ---------------------------------------------------------------------------

export function stopProcessWith(
  ctx: ProcessLifecycleContext,
  clearKillFiber: (proc: PtyProcess | null) => Effect.Effect<void>,
  startKillEscalation: (
    proc: PtyProcess,
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<void>,
  session: TerminalSessionState,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const process = session.process;
    if (!process) return;

    yield* ctx.modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = new Date().toISOString();
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* startKillEscalation(process, session.threadId, session.terminalId);
    yield* ctx.evictInactiveSessionsIfNeeded();
  }).pipe(Effect.withSpan("terminal.stopProcess"));
}

// ---------------------------------------------------------------------------
// startSessionWith
// ---------------------------------------------------------------------------

export function startSessionWith(
  ctx: ProcessLifecycleContext,
  stopProcess: (session: TerminalSessionState) => Effect.Effect<void>,
  startKillEscalation: (
    proc: PtyProcess,
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<void>,
  drainProcessEvents: (session: TerminalSessionState, expectedPid: number) => Effect.Effect<void>,
  snapshotFn: (session: TerminalSessionState) => TerminalSessionSnapshot,
  session: TerminalSessionState,
  input: TerminalStartInput,
  eventType: "started" | "restarted",
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    yield* ctx.modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = new Date().toISOString();
      return [undefined, state] as const;
    });

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(ctx.shellResolver);
            const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv);
            const spawnResult = yield* trySpawnWith(ctx, session, shellCandidates, terminalEnv);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                return;
              }
              ctx.runFork(drainProcessEvents(session, processPid));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                return;
              }
              ctx.runFork(drainProcessEvents(session, processPid));
            });

            yield* ctx.modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.updatedAt = new Date().toISOString();
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              return [undefined, state] as const;
            });

            yield* ctx.publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              createdAt: new Date().toISOString(),
              snapshot: snapshotFn(session),
            });
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
      }

      yield* ctx.modifyManagerState((state) => {
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.unsubscribeData = null;
        session.unsubscribeExit = null;
        session.hasRunningSubprocess = false;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.updatedAt = new Date().toISOString();
        return [undefined, state] as const;
      });

      yield* ctx.evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* ctx.publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }).pipe(Effect.withSpan("terminal.startSession"));
}

// ---------------------------------------------------------------------------
// pollSubprocessActivityWith
// ---------------------------------------------------------------------------

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
