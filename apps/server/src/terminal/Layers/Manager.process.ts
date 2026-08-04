// TODO: Split by concern when this file is next touched.
import { type TerminalEvent } from "@bigbud/contracts";
import { makeKeyedCoalescingWorker } from "@bigbud/shared/KeyedCoalescingWorker";
import { Effect, Exit, FileSystem, Option, Scope, Semaphore, SynchronizedRef } from "effect";

import { type PtyProcess } from "../Services/PTY";
import { defaultShellResolver, defaultSubprocessChecker, toSessionKey } from "./Manager.shell";
import {
  drainProcessEventsWith,
  pollSubprocessActivityWith,
  startSessionWith,
  stopProcessWith,
} from "./Manager.process-drain";
import {
  cleanupProcessHandles,
  clearKillFiberWith,
  enqueueProcessEvent,
  registerKillFiberWith,
  runKillEscalationWith,
  snapshot,
  type ProcessLifecycleContext,
} from "./Manager.process-lifecycle";
import { buildSessionApi } from "./Manager.session";
import { makeTerminalPersistence } from "./Manager.process.persistence.ts";
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

const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (input: {
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

export const makeTerminalManagerWithOptions = Effect.fn("makeTerminalManagerWithOptions")(
  function* (options: TerminalManagerOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const services = yield* Effect.services();
    const runFork = Effect.runForkWith(services);

    const logsDir = options.logsDir;
    const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    const shellResolver = options.shellResolver ?? defaultShellResolver;
    const subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    const subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    const maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;

    yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

    const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
      sessions: new Map(),
      killFibers: new Map(),
    });
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

    const acquireWorktreeLease = (input: {
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

    const publishEvent = (event: TerminalEvent) =>
      Effect.gen(function* () {
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

    const ptyOutputWorker = yield* makeKeyedCoalescingWorker<
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
          runFork(drainProcessEvents(request.session, request.expectedPid));
        }),
    });

    const queuePtyOutput = Effect.fn("terminal.queuePtyOutput")(function* (
      session: TerminalSessionState,
      expectedPid: number,
      data: string,
    ) {
      yield* ptyOutputWorker.enqueue(toSessionKey(session.threadId, session.terminalId), {
        session,
        expectedPid,
        data,
      });
    });

    const flushPtyOutput = Effect.fn("terminal.flushPtyOutput")(function* (
      threadId: string,
      terminalId: string,
    ) {
      yield* ptyOutputWorker.drainKey(toSessionKey(threadId, terminalId));
    });

    const { readHistory, deleteHistory, deleteAllHistoryForThread } = makeHistoryAccessors({
      logsDir,
      historyLineLimit,
      fileSystem,
    });
    const assertValidCwd = makeAssertValidCwd(fileSystem);

    const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
      function* () {
        yield* modifyManagerState((state) => {
          const inactiveSessions = [...state.sessions.values()].filter(
            (session) => session.status !== "running",
          );
          if (inactiveSessions.length <= maxRetainedInactiveSessions) {
            return [undefined, state] as const;
          }

          inactiveSessions.sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          );

          const sessions = new Map(state.sessions);

          const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
          for (const session of inactiveSessions.slice(0, toEvict)) {
            const key = toSessionKey(session.threadId, session.terminalId);
            sessions.delete(key);
          }

          return [undefined, { ...state, sessions }] as const;
        });
      },
    );

    const lifecycleCtx: ProcessLifecycleContext = {
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
      subprocessPollIntervalMs,
      shellResolver,
      ptyAdapter: options.ptyAdapter,
    };

    const clearKillFiber = (proc: PtyProcess | null) =>
      clearKillFiberWith(lifecycleCtx.modifyManagerState, proc);

    const drainProcessEvents = (session: TerminalSessionState, expectedPid: number) =>
      drainProcessEventsWith(lifecycleCtx, clearKillFiber, session, expectedPid).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            session.process === null
              ? releaseWorktreeLease({
                  threadId: session.threadId,
                  terminalId: session.terminalId,
                })
              : Effect.void,
          ),
        ),
      );

    const stopProcess = (session: TerminalSessionState) =>
      stopProcessWith(
        lifecycleCtx,
        clearKillFiber,
        (proc, threadId, terminalId) =>
          startKillEscalation({
            lifecycleCtx,
            processKillGraceMs,
            workerScope,
            proc,
            threadId,
            terminalId,
          }),
        session,
      );

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

    const pollSubprocessActivity = () => pollSubprocessActivityWith(lifecycleCtx);

    yield* Effect.forever(
      readManagerState.pipe(
        Effect.map((state) =>
          [...state.sessions.values()].some((session) => session.status === "running"),
        ),
        Effect.flatMap((active) =>
          active
            ? pollSubprocessActivity().pipe(
                Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
              )
            : Effect.sleep(subprocessPollIntervalMs),
        ),
      ),
    ).pipe(Effect.forkIn(workerScope));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
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

        const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
          session: TerminalSessionState,
        ) {
          cleanupProcessHandles(session);
          if (!session.process) return;
          yield* clearKillFiber(session.process);
          yield* runKillEscalationWith(
            processKillGraceMs,
            session.process,
            session.threadId,
            session.terminalId,
          );
          yield* releaseWorktreeLease({
            threadId: session.threadId,
            terminalId: session.terminalId,
          });
        });

        yield* Effect.forEach(sessions, cleanupSession, {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    );

    return buildSessionApi({
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
      readHistory,
      deleteHistory,
      deleteAllHistoryForThread,
      evictInactiveSessionsIfNeeded,
      assertValidCwd,
      snapshot,
      acquireWorktreeLease,
      markWorktreeLeaseStarted,
      releaseWorktreeLease,
      terminalEventListeners,
    });
  },
);
