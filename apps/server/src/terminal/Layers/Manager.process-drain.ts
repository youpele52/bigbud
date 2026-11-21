import { type TerminalSessionSnapshot } from "@bigbud/contracts";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import { increment, terminalSessionsTotal } from "../../observability/Metrics";
import { type PtyProcess } from "../Services/PTY";
import {
  createTerminalSpawnEnv,
  defaultTerminalDropPathMode,
  resolveShellCandidates,
} from "./Manager.shell";
import { createRemoteShellPidReader } from "./Manager.remote-identity.ts";
import { buildRemoteTerminalShellCandidate } from "./Manager.remote.ts";
import { withInteractiveTerminalIdentity } from "./Manager.shell.identity.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { buildWslTerminalShellCandidate } from "./Manager.wsl.invocation";
import { enqueueProcessEvent, type ProcessLifecycleContext } from "./Manager.process-lifecycle";
import { type TerminalSessionState, type TerminalStartInput } from "./Manager.types";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { TerminalDeviceQueries } from "./TerminalDeviceQueries";
import { observeTerminalProcessError } from "./Manager.process.error";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { resolveTerminalRemoteShellIntent } from "./Manager.shell.intent";
import { resolveOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import { ownedTerminalMayBeRetained } from "./OwnedPtyRuntime.owner.ts";
import { drainProcessEventsWith } from "./Manager.process-drain.events.ts";
import { startRecoveryModel, feedRecoveryModel } from "./Manager.recovery";
import { beginTerminalHostSession, bindTerminalHostLifecycle } from "./Manager.hostLifecycle.ts";
import { findTerminalHostLimitError } from "./Manager.hostLimit.ts";
export { drainProcessEventsWith } from "./Manager.process-drain.events.ts";
import { cleanupFailedTerminalObserver } from "./Manager.process-drain.stop.ts";
export { cleanupFailedTerminalObserver, stopProcessWith } from "./Manager.process-drain.stop.ts";
export {
  pollSubprocessActivityWith,
  startProcessPollingWith,
} from "./Manager.process-drain.poll.ts";

import { trySpawnWith } from "./Manager.process.spawn";
export { trySpawnWith } from "./Manager.process.spawn";

/** OSC 133 shell integration env for local POSIX panes only (remote shells are untouched). */
function withLocalShellIntegration(
  ctx: ProcessLifecycleContext,
  session: TerminalSessionState,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!ctx.shellIntegrationEnv || process.platform === "win32") return env;
  if (!isLocalExecutionTarget(session.executionTargetId)) return env;
  const extra = ctx.shellIntegrationEnv(env);
  return extra ? { ...env, ...extra } : env;
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
    const remoteLaunch = yield* resolveTerminalRemoteShellIntent({
      threadId: session.threadId,
      terminalId: session.terminalId,
      executionTargetId: session.executionTargetId,
      cwd: input.cwd,
      launch: input.shellProfileLaunch,
      recoverOnly: session.remoteOwnerRecoveryRequired === true,
    });
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    yield* ctx.modifyManagerState((state) => {
      if (eventType === "restarted") session.expectedRemoteResourceId = undefined;
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
      session.host = undefined;
      session.endedReason = undefined;
      session.hostLimitRefusal = undefined;
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
            const shellCandidates = remoteLaunch
              ? [
                  {
                    ...buildRemoteTerminalShellCandidate(session),
                    shellLaunch: remoteLaunch,
                    dropPathMode: input.shellProfileLaunch!.dropPathMode,
                  },
                ]
              : input.shellProfileLaunch
                ? [{ ...input.shellProfileLaunch, args: [...input.shellProfileLaunch.args] }]
                : isLocalExecutionTarget(session.executionTargetId)
                  ? resolveShellCandidates(ctx.shellResolver)
                  : isWslTerminalTargetId(session.executionTargetId)
                    ? [buildWslTerminalShellCandidate(session)]
                    : [buildRemoteTerminalShellCandidate(session)];
            const terminalEnv = withLocalShellIntegration(
              ctx,
              session,
              withInteractiveTerminalIdentity(
                createTerminalSpawnEnv(
                  process.env,
                  isLocalExecutionTarget(session.executionTargetId) ? session.runtimeEnv : null,
                ),
              ),
            );
            const spawnResult = yield* trySpawnWith(
              ctx,
              session,
              shellCandidates,
              terminalEnv,
              input.hostLifecycle,
            );
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
            // Installed before onData: host output is counted for the screen splice (S3).
            const hostSession = beginTerminalHostSession(session, ptyProcess);
            session.host = hostSession?.state;
            // A host query responder and the view answer queries (§8.9); never answer twice.
            const queries =
              ptyProcess.screen?.capabilities().queryResponder !== true &&
              (isLocalExecutionTarget(session.executionTargetId) ||
                isWslTerminalTargetId(session.executionTargetId))
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
              const work = ctx.workSignals?.output(session, visible);
              if (work) ctx.runFork(work);
              const output = queries ? queries.receive(visible) : visible;
              feedRecoveryModel(session, output);
              if (!output) return;
              session.host?.ledger.noteData(output);
              ctx.runFork(ctx.queuePtyOutput(session, processPid, output));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (session.runtimeEpoch !== runtimeEpoch) return;
              session.observedExit = { process: queryProcess, event };
              const tail = queries?.finish();
              if (tail) feedRecoveryModel(session, tail);
              if (tail) session.host?.ledger.noteData(tail);
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

            const unbindHost = ctx.hostHub
              ? bindTerminalHostLifecycle({
                  hub: ctx.hostHub,
                  session,
                  process: queryProcess,
                  runFork: (effect) => void ctx.runFork(effect),
                })
              : undefined;
            yield* ctx.modifyManagerState((state) => {
              session.shellLaunchIdentity = spawnResult.identity;
              session.shellUnconfirmedLaunch = ptyProcess?.shellUnconfirmedLaunch;
              session.process = ptyProcess;
              session.remoteOwnerRecoveryRequired = false;
              session.pid = processPid;
              session.status = "running";
              session.dropPathMode = startedDropPathMode ?? session.dropPathMode;
              session.updatedAt = nextTerminalTimestamp(session.updatedAt);
              session.unsubscribeData = () => {
                unsubscribeData();
                hostSession?.dispose();
                unbindHost?.();
              };
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
            if (session.host) ctx.hostHub?.sessionStarted(session.threadId, session.terminalId);
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      // A limit refusal created nothing; the open reports it as TerminalLimitError instead.
      session.hostLimitRefusal = findTerminalHostLimitError(error);
      session.host = undefined;
      session.recoveryModel?.dispose("launch-failed");
      yield* cleanupFailedTerminalObserver(ptyProcess, (process) =>
        startKillEscalation(process, session.threadId, session.terminalId),
      );

      // Only a durable owner that may still be live fences the pane; a launch that was
      // rolled back or never dispatched leaves nothing to recover, so Retry starts fresh.
      const ownedRuntime = resolveOwnedPtyRuntime(ctx.ptyAdapter, session.executionTargetId);
      const ownerMayBeRetained = ownedRuntime
        ? yield* ownedTerminalMayBeRetained(ownedRuntime, session.threadId, session.terminalId)
        : session.remoteOwnerRecoveryRequired === true;
      yield* ctx.modifyManagerState((state) => {
        session.status = "error";
        session.remoteOwnerRecoveryRequired = ownerMayBeRetained;
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
      if (session.hostLimitRefusal) {
        yield* Effect.logInfo("terminal host refused a terminal at its live limit", {
          threadId: session.threadId,
          terminalId: session.terminalId,
        });
        return;
      }
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
