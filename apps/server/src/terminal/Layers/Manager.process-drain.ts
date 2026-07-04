import { type TerminalSessionSnapshot } from "@bigbud/contracts";
import { Effect } from "effect";

import { increment, terminalSessionsTotal } from "../../observability/Metrics";
import { PtySpawnError, type PtyProcess } from "../Services/PTY";
import {
  createTerminalSpawnEnv,
  formatShellCandidate,
  isRetryableShellSpawnError,
  resolveShellCandidates,
} from "./Manager.shell";
import { buildRemoteTerminalShellCandidate } from "./Manager.remote.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import {
  cleanupProcessHandles,
  enqueueProcessEvent,
  type ProcessLifecycleContext,
} from "./Manager.process-lifecycle";
import { type TerminalSessionState, type TerminalStartInput } from "./Manager.types";
export { drainProcessEventsWith } from "./Manager.process-drain.events.ts";
export { pollSubprocessActivityWith } from "./Manager.process-drain.poll.ts";

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
      session.runtimeEpoch += 1;
      session.updatedAt = new Date().toISOString();
      return [undefined, state] as const;
    });

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = isLocalExecutionTarget(session.executionTargetId)
              ? resolveShellCandidates(ctx.shellResolver)
              : [buildRemoteTerminalShellCandidate(session)];
            const terminalEnv = createTerminalSpawnEnv(
              process.env,
              isLocalExecutionTarget(session.executionTargetId) ? session.runtimeEnv : null,
            );
            const spawnResult = yield* trySpawnWith(ctx, session, shellCandidates, terminalEnv);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const runtimeEpoch = session.runtimeEpoch;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (session.runtimeEpoch !== runtimeEpoch) {
                return;
              }
              ctx.runFork(ctx.queuePtyOutput(session, processPid, data));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              ctx.runFork(
                Effect.gen(function* () {
                  yield* ctx.flushPtyOutput(session.threadId, session.terminalId);
                  if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                    return;
                  }
                  yield* drainProcessEvents(session, processPid);
                }),
              );
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
