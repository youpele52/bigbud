import { hasUnconfirmedDirectShell } from "./Manager.shell.direct.policy";
import { makeInactiveSessionEviction } from "./Manager.process.eviction.ts";
import { makeTerminalIdleWorkTracker } from "./Manager.idleWork.ts";
import { makeTerminalWorkSignals } from "./Manager.workSignals.ts";
import { resolveOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import { type TerminalEvent } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { type PtyProcess } from "../Services/PTY";
import { scheduleRemoteTerminalInspection } from "./Manager.remote-inspection.schedule.ts";
import { inspectRemoteTerminalProcesses } from "./Manager.remote-inspection.ts";
import { defaultTerminalAgentDetector } from "./Manager.agentDetection";
import { defaultShellResolver, defaultSubprocessChecker } from "./Manager.shell";
import {
  drainProcessEventsWith,
  startProcessPollingWith,
  startSessionWith,
  stopProcessWith,
} from "./Manager.process-drain";
import {
  clearKillFiberWith,
  snapshot,
  type ProcessLifecycleContext,
} from "./Manager.process-lifecycle";
import { makeTerminalPtyOutputQueue, startKillEscalation } from "./Manager.process.output.ts";
import { buildSessionApi } from "./Manager.session";
import { makeTerminalPersistence } from "./Manager.process.persistence.ts";
import { cleanupTerminalSessions } from "./Manager.process.shutdown.ts";
import { makeTerminalManagerHost } from "./Manager.process.host.ts";
import {
  DEFAULT_HISTORY_LINE_LIMIT,
  DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS,
  DEFAULT_PROCESS_KILL_GRACE_MS,
  DEFAULT_SUBPROCESS_POLL_INTERVAL_MS,
  type TerminalManagerOptions,
  type TerminalManagerState,
  type TerminalSessionState,
  type TerminalStartInput,
} from "./Manager.types";
import {
  makeAssertValidCwd,
  makeHistoryAccessors,
  makeManagerStateAccessors,
} from "./Manager.process.state.ts";

// Re-export for external consumers (tests import this directly)
export type { TerminalManagerOptions };

export const makeTerminalManagerWithOptions = Effect.fn("makeTerminalManagerWithOptions")(
  function* (options: TerminalManagerOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const services = yield* Effect.services();
    const runFork = Effect.runForkWith(services);

    const logsDir = options.logsDir;
    const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    const shellResolver = options.shellResolver ?? defaultShellResolver;
    const subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    const agentDetector = options.agentDetector ?? defaultTerminalAgentDetector;
    const subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    const maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;

    // History persistence is best-effort; an unwritable log directory must not stop the server.
    yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to create terminal log directory", {
          logsDir,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
      sessions: new Map(),
      killFibers: new Map(),
    });
    const host = makeTerminalManagerHost({
      options,
      stateRef: managerStateRef,
      runFork: (effect) => void runFork(effect),
    });
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

    const acquireWorktreeLease = (input: {
      runtimePathIdentity?: import("./Manager.types").RuntimePathIdentity | undefined;
      threadId: string;
      terminalId: string;
      executionTargetId: string;
      cwd: string;
      worktreePath: string | null | undefined;
    }) =>
      options.acquireWorktreeLease
        ? options.acquireWorktreeLease({ ...input, worktreePath: input.worktreePath ?? null })
        : Effect.void;
    const releaseWorktreeLease = (input: { threadId: string; terminalId: string }) =>
      options.releaseWorktreeLease?.(input) ?? Effect.void;
    const markWorktreeLeaseStarted = (input: {
      threadId: string;
      terminalId: string;
      processId: number;
    }) => options.markWorktreeLeaseStarted?.(input) ?? Effect.void;

    const idleWork = makeTerminalIdleWorkTracker();
    const refreshIdleWork = Effect.suspend(() =>
      readManagerState.pipe(Effect.map((state) => idleWork.refresh(state.sessions.values()))),
    );
    const refreshThreadIdleWork = (threadId: string) =>
      sessionsForThread(threadId).pipe(
        Effect.map((sessions) => idleWork.refreshThread(threadId, sessions)),
      );
    const workSignals = makeTerminalWorkSignals(options.workSink);
    const publishEvent = (event: TerminalEvent) =>
      Effect.gen(function* () {
        if (event.type !== "output") yield* refreshThreadIdleWork(event.threadId);
        if (event.type === "activity" && workSignals.enabled) {
          const session = yield* getSession(event.threadId, event.terminalId);
          if (Option.isSome(session))
            yield* workSignals.activity(session.value, event.hasRunningSubprocess);
        }
        for (const listener of terminalEventListeners) {
          yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
        }
      });

    const { readManagerState, modifyManagerState, getSession, requireSession, sessionsForThread } =
      makeManagerStateAccessors(managerStateRef);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(
      threadId: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const { flushPersist, persistHistory, queuePersist } = yield* makeTerminalPersistence({
      fileSystem,
      logsDir,
    });

    const { queuePtyOutput, flushPtyOutput } = yield* makeTerminalPtyOutputQueue({
      runFork,
      drain: (session, expectedPid) => drainProcessEvents(session, expectedPid),
    });

    const history = makeHistoryAccessors({
      logsDir,
      historyLineLimit,
      fileSystem,
    });
    const assertValidCwd = makeAssertValidCwd(fileSystem);

    const evictInactiveSessionsIfNeeded = makeInactiveSessionEviction(
      modifyManagerState,
      maxRetainedInactiveSessions,
      (session) => host.hostClosed.record(session),
    );

    const lifecycleCtx: ProcessLifecycleContext = {
      refreshIdleWork,
      refreshThreadIdleWork,
      modifyManagerState,
      readManagerState,
      publishEvent,
      queuePtyOutput,
      flushPtyOutput,
      evictInactiveSessionsIfNeeded,
      queuePersist,
      processKillGraceMs,
      historyLineLimit,
      workerScope,
      runFork,
      subprocessChecker,
      agentDetector,
      remoteProcessInspector:
        options.remoteProcessInspector ??
        scheduleRemoteTerminalInspection(inspectRemoteTerminalProcesses),
      subprocessPollIntervalMs,
      shellResolver,
      ptyAdapter: options.ptyAdapter,
      directShellOwners: options.directShellOwners,
      workSignals,
      shellIntegrationEnv: options.shellIntegrationEnv,
      hostHub: host.hub,
    };

    const clearKillFiber = (proc: PtyProcess | null) =>
      clearKillFiberWith(lifecycleCtx.modifyManagerState, proc);

    const drainProcessEvents = (session: TerminalSessionState, expectedPid: number) =>
      drainProcessEventsWith(lifecycleCtx, clearKillFiber, session, expectedPid).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            session.process === null && !hasUnconfirmedDirectShell(session)
              ? releaseWorktreeLease({
                  threadId: session.threadId,
                  terminalId: session.terminalId,
                })
              : Effect.void,
          ),
        ),
      );

    const stopProcess = (session: TerminalSessionState) =>
      stopProcessWith(lifecycleCtx, clearKillFiber, session);

    const startSession = (
      session: TerminalSessionState,
      input: TerminalStartInput,
      eventType: "started" | "restarted",
    ) =>
      startSessionWith(
        lifecycleCtx,
        stopProcess,
        (proc, threadId, terminalId) =>
          startKillEscalation({
            lifecycleCtx,
            processKillGraceMs,
            workerScope,
            proc,
            threadId,
            terminalId,
          }),
        drainProcessEvents,
        snapshot,
        session,
        input,
        eventType,
      );

    yield* startProcessPollingWith(lifecycleCtx);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* host.shutdown;
        const sessions = yield* modifyManagerState(
          (state) =>
            [
              [...state.sessions.values()],
              {
                ...state,
                sessions: new Map(),
              },
            ] as const,
        );

        yield* cleanupTerminalSessions({
          sessions,
          processKillGraceMs,
          clearKillFiber,
          releaseWorktreeLease,
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    );

    const api = buildSessionApi({
      resolveOwnedRuntime: (target) => resolveOwnedPtyRuntime(options.ptyAdapter, target),
      getLocalShellDefault: options.getLocalShellDefault,
      listLocalShellProfiles: options.listLocalShellProfiles,
      publishEvent,
      modifyManagerState,
      getSession,
      requireSession,
      sessionsForThread,
      withThreadLock,
      stopProcess: stopProcess,
      startSession: startSession,
      flushPtyOutput,
      persistHistory,
      flushPersist,
      ...history,
      historyTerminalIdsForThread: host.historyTerminalIdsForThread(
        history.historyTerminalIdsForThread,
      ),
      hostInventory: host.hostInventory,
      hostLimit: host.hostLimit,
      hostClosed: host.hostClosed,
      evictInactiveSessionsIfNeeded,
      assertValidCwd,
      resolveRuntimePathIdentity: options.resolveRuntimePathIdentity,
      directSshCwdOwner: options.directSshCwdOwner,
      directShellOwners: options.directShellOwners,
      resolveShellProfile: options.resolveShellProfile,
      preflightRemoteShellProfile: options.preflightRemoteShellProfile,
      listShellProfiles: options.listShellProfiles,
      snapshot,
      acquireWorktreeLease,
      markWorktreeLeaseStarted,
      releaseWorktreeLease,
      terminalEventListeners,
      workSignals,
    });
    host.start();
    return {
      ...api,
      ...host.api({ getSession, subscribe: (listener) => api.subscribe(listener) }),
      getThreadIdleWork: (threadId: string) =>
        refreshThreadIdleWork(threadId).pipe(Effect.map(() => idleWork.get(threadId))),
      forgetThreadIdleWork: (threadId: string) => Effect.sync(() => idleWork.forget(threadId)),
      snapshotThreadIdleWork: () => Effect.sync(() => idleWork.snapshot()),
      close: (input: Parameters<typeof api.close>[0]) =>
        refreshThreadIdleWork(input.threadId).pipe(
          Effect.andThen(api.close(input)),
          Effect.ensuring(refreshThreadIdleWork(input.threadId)),
        ),
    };
  },
);
