import { type TerminalSessionSnapshot } from "@bigbud/contracts";
import { Effect } from "effect";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import { increment, terminalSessionsTotal } from "../../observability/Metrics";
import { PtySpawnError, type PtyProcess } from "../Services/PTY";
import {
  createTerminalSpawnEnv,
  defaultTerminalDropPathMode,
  formatShellCandidate,
  isRetryableShellSpawnError,
  resolveShellCandidates,
} from "./Manager.shell";
import { createRemoteShellPidReader } from "./Manager.remote-identity.ts";
import { buildRemoteTerminalShellCandidate } from "./Manager.remote.ts";
import { withInteractiveTerminalIdentity } from "./Manager.shell.identity.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { buildWslTerminalShellCandidate } from "./Manager.wsl.invocation";
import {
  cleanupProcessHandles,
  enqueueProcessEvent,
  type ProcessLifecycleContext,
} from "./Manager.process-lifecycle";
import { type TerminalSessionState, type TerminalStartInput } from "./Manager.types";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { confirmTerminalProcessStopped } from "./Manager.process.stop";
import { TerminalDeviceQueries } from "./TerminalDeviceQueries";
import { observeTerminalProcessError } from "./Manager.process.error";
import type { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { drainProcessEventsWith } from "./Manager.process-drain.events.ts";
import { startRecoveryModel, feedRecoveryModel } from "./Manager.recovery";
export { drainProcessEventsWith } from "./Manager.process-drain.events.ts";
export {
  pollSubprocessActivityWith,
  startProcessPollingWith,
} from "./Manager.process-drain.poll.ts";

// ---------------------------------------------------------------------------
// trySpawnWith
// ---------------------------------------------------------------------------

export function trySpawnWith(
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  shellCandidates: ReadonlyArray<{
    shell: string;
    label?: string;
    args?: string[];
    dropPathMode: TerminalSessionState["dropPathMode"];
  }>,
  spawnEnv: NodeJS.ProcessEnv,
  index = 0,
  lastError: PtySpawnError | null = null,
): Effect.Effect<
  { process: PtyProcess; shellLabel: string; dropPathMode: TerminalSessionState["dropPathMode"] },
  PtySpawnError
> {
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
      // Suspended so an adapter that throws before returning an Effect is caught too.
      Effect.suspend(() =>
        ctx.ptyAdapter.spawn({
          ownerKey: JSON.stringify([session.threadId, session.terminalId]),
          recoverOnly: session.remoteOwnerRecoveryRequired === true,
          shell: candidate.shell,
          ...(candidate.args ? { args: candidate.args } : {}),
          cwd: isLocalExecutionTarget(session.executionTargetId) ? session.cwd : homedir(),
          cols: session.cols,
          rows: session.rows,
          env: spawnEnv,
          executionTargetId: session.executionTargetId,
          ...(isLocalExecutionTarget(session.executionTargetId) ||
          isWslTerminalTargetId(session.executionTargetId)
            ? {}
            : { remoteCwd: session.cwd }),
        }),
      ).pipe(
        // A throwing adapter must still reach the fallback chain and the session error state.
        Effect.catchDefect((defect) =>
          Effect.fail(
            new PtySpawnError({
              adapter: "terminal-manager",
              message: `PTY adapter failed unexpectedly: ${
                defect instanceof Error ? defect.message : String(defect)
              }`,
              cause: defect,
            }),
          ),
        ),
      ),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
        dropPathMode: candidate.dropPathMode,
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

// ---------------------------------------------------------------------------
// startSessionWith
// ---------------------------------------------------------------------------

export function startSessionWith(
  ctx: ProcessLifecycleContext,
  stopProcess: (session: TerminalSessionState) => Effect.Effect<void, TerminalExecutionTargetError>,
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
): Effect.Effect<void, TerminalExecutionTargetError> {
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
      session.observedExit = undefined;
      session.exitCode = null;
      session.exitSignal = null;
      session.dropPathMode = defaultTerminalDropPathMode(session.executionTargetId);
      session.hasRunningSubprocess = false;
      session.activeAgentProvider = null;
      session.activeAgent = null;
      session.agentIdentityMisses = 0;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.remoteShellPid = undefined;
      session.runtimeEpoch += 1;
      session.runtimeGeneration = randomUUID();
      session.modeTracker = undefined; // Modes belong to one process generation.
      session.updatedAt = nextTerminalTimestamp(session.updatedAt);
      return [undefined, state] as const;
    });

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    let startedDropPathMode: TerminalSessionState["dropPathMode"] | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = isLocalExecutionTarget(session.executionTargetId)
              ? resolveShellCandidates(ctx.shellResolver)
              : isWslTerminalTargetId(session.executionTargetId)
                ? [buildWslTerminalShellCandidate(session)]
                : [buildRemoteTerminalShellCandidate(session)];
            const terminalEnv = withInteractiveTerminalIdentity(
              createTerminalSpawnEnv(
                process.env,
                isLocalExecutionTarget(session.executionTargetId) ? session.runtimeEnv : null,
              ),
            );
            const spawnResult = yield* trySpawnWith(ctx, session, shellCandidates, terminalEnv);
            ptyProcess = spawnResult.process;
            // A durable remote owner resumes after its acknowledged output cut,
            // not from process birth. Empty local history is not a valid baseline.
            session.historyUnavailable = ptyProcess.recovered === true;
            startRecoveryModel(session, ptyProcess.recovered === true, ptyProcess);
            startedShell = spawnResult.shellLabel;
            startedDropPathMode = spawnResult.dropPathMode;

            const processPid = ptyProcess.pid;
            const runtimeEpoch = session.runtimeEpoch;
            const readRemotePid =
              !isLocalExecutionTarget(session.executionTargetId) &&
              !isWslTerminalTargetId(session.executionTargetId) &&
              ptyProcess.pidDomain !== "remote"
                ? createRemoteShellPidReader(session.runtimeGeneration, (pid) => {
                    session.remoteShellPid = pid;
                  })
                : (data: string) => data;
            const queryProcess = ptyProcess;
            const queries =
              isLocalExecutionTarget(session.executionTargetId) ||
              isWslTerminalTargetId(session.executionTargetId)
                ? new TerminalDeviceQueries((reply) => {
                    if (session.runtimeEpoch !== runtimeEpoch || session.stopPending) return false;
                    try {
                      queryProcess.write(reply);
                      return true;
                    } catch {
                      return false;
                    }
                  })
                : null;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (session.runtimeEpoch !== runtimeEpoch) {
                return;
              }
              const visible = readRemotePid(data);
              const output = queries ? queries.receive(visible) : visible;
              feedRecoveryModel(session, output);
              if (output) ctx.runFork(ctx.queuePtyOutput(session, processPid, output));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (session.runtimeEpoch !== runtimeEpoch) return;
              session.observedExit = { process: queryProcess, event };
              const tail = queries?.finish();
              if (tail) feedRecoveryModel(session, tail);
              if (tail) ctx.runFork(ctx.queuePtyOutput(session, processPid, tail));
              // Explicit restart owns the exit while awaiting durable remote release.
              if (
                session.stopPending ||
                session.restartPending ||
                session.runtimeEpoch !== runtimeEpoch
              )
                return;
              ctx.runFork(
                Effect.gen(function* () {
                  yield* ctx.flushPtyOutput(session.threadId, session.terminalId);
                  if (
                    session.stopPending ||
                    session.restartPending ||
                    session.runtimeEpoch !== runtimeEpoch
                  )
                    return;
                  if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                    return;
                  }
                  yield* drainProcessEvents(session, processPid);
                }),
              );
            });

            yield* ctx.modifyManagerState((state) => {
              session.process = ptyProcess;
              session.remoteOwnerRecoveryRequired = false;
              session.pid = processPid;
              session.status = "running";
              session.dropPathMode = startedDropPathMode ?? session.dropPathMode;
              session.updatedAt = nextTerminalTimestamp(session.updatedAt);
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              return [undefined, state] as const;
            });
            session.unsubscribeError = observeTerminalProcessError(
              ctx,
              session,
              queryProcess,
              runtimeEpoch,
            );

            yield* ctx.publishEvent({
              type: eventType,
              threadId: session.threadId,
              terminalId: session.terminalId,
              createdAt: session.updatedAt,
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
      session.recoveryModel?.dispose("launch-failed");
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
        session.updatedAt = nextTerminalTimestamp(session.updatedAt);
        return [undefined, state] as const;
      });

      yield* ctx.evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* ctx.publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: session.updatedAt,
        runtimeGeneration: session.runtimeGeneration,
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
