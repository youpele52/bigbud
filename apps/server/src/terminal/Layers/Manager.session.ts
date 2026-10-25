import { DEFAULT_TERMINAL_ID, resolveExecutionTargetId } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { increment, terminalRestartsTotal } from "../../observability/Metrics";
import { makeTerminalSessionControls } from "./Manager.session.controls.ts";
import { defaultTerminalDropPathMode, normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS } from "./Manager.types";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state.ts";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { subscribeToTerminalEvents } from "./Manager.session.subscription.ts";
import { type SessionApiContext, type TerminalManagerShape } from "./Manager.session.types.ts";
import { type TerminalSessionState } from "./Manager.types";
import { makeResolveTerminalFolder } from "./Manager.cwd";
import { TerminalNotRunningError } from "../Services/Manager";
import { makeTerminalClose } from "./Manager.session.close";
import { prepareTerminalRestart } from "./Manager.session.restart";
import { makeTerminalOutputHold } from "./Manager.session.outputHold";
import { TerminalSearchIndex } from "./Manager.search";

export function buildSessionApi(ctx: SessionApiContext): TerminalManagerShape {
  const {
    withThreadLock,
    getSession,
    requireSession,
    sessionsForThread,
    modifyManagerState,
    stopProcess,
    startSession,
    flushPtyOutput,
    persistHistory,
    flushPersist,
    evictInactiveSessionsIfNeeded,
    assertValidCwd,
    publishEvent,
    snapshot,
    acquireWorktreeLease,
    markWorktreeLeaseStarted,
    releaseWorktreeLease,
    terminalEventListeners,
  } = ctx;

  const resolveFolder = makeResolveTerminalFolder(
    assertValidCwd,
    undefined,
    undefined,
    ctx.resolveRuntimePathIdentity,
  );

  const open: TerminalManagerShape["open"] = (request) =>
    withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        const terminalId = request.terminalId ?? DEFAULT_TERMINAL_ID;
        const existing = yield* getSession(request.threadId, terminalId);
        // Open means reattach, never reinterpret mutable chat launch settings as a restart.
        if (Option.isSome(existing) && existing.value.process) {
          const session = existing.value;
          const cols = request.cols ?? session.cols;
          const rows = request.rows ?? session.rows;
          if (session.cols !== cols || session.rows !== rows) {
            session.cols = cols;
            session.rows = rows;
            session.updatedAt = nextTerminalTimestamp(session.updatedAt);
            session.process!.resize(cols, rows);
          }
          return snapshot(session);
        }
        const executionTargetId = resolveExecutionTargetId(request.executionTargetId);
        const folder = yield* resolveFolder({
          threadId: request.threadId,
          terminalId,
          executionTargetId,
          cwd: request.cwd,
          worktreePath: request.worktreePath,
          env: request.env,
        });
        const input = {
          ...request,
          cwd: folder.cwd,
          ...(folder.wslIdentity ? { worktreePath: folder.worktreePath, env: folder.env } : {}),
          ...(folder.directoryFallback ? { worktreePath: null, env: undefined } : {}),
        };
        const sessionKey = toSessionKey(input.threadId, terminalId);
        if (Option.isNone(existing)) {
          yield* flushPtyOutput(input.threadId, terminalId);
          yield* flushPersist(input.threadId, terminalId);
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          const session = createTerminalSessionState({
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            dropPathMode: defaultTerminalDropPathMode(executionTargetId),
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            // A new process starts fresh; disk logs are not emulator checkpoints.
            history: "",
            cols,
            rows,
            runtimeEnv: normalizedRuntimeEnv(input.env),
          });
          session.directoryFallback = folder.directoryFallback;
          session.wslIdentity = folder.wslIdentity;

          const createdSession = session;
          session.remoteOwnerRecoveryRequired = yield* ctx.historyExists(
            input.threadId,
            terminalId,
          );
          yield* modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [undefined, { ...state, sessions }] as const;
          });

          yield* evictInactiveSessionsIfNeeded();
          yield* acquireWorktreeLease({
            runtimePathIdentity: folder.runtimePathIdentity,
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            cwd: input.cwd,
            worktreePath: input.worktreePath,
          });
          yield* startSession(
            session,
            {
              threadId: input.threadId,
              terminalId,
              executionTargetId,
              cwd: input.cwd,
              ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
              cols,
              rows,
              ...(input.env ? { env: input.env } : {}),
            },
            "started",
          ).pipe(
            Effect.onError(() => releaseWorktreeLease({ threadId: input.threadId, terminalId })),
          );
          if (session.pid !== null) {
            yield* markWorktreeLeaseStarted({
              threadId: input.threadId,
              terminalId,
              processId: session.pid,
            });
          }
          return snapshot(session);
        }

        const liveSession = existing.value;
        const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
        const targetCols = input.cols ?? liveSession.cols;
        const targetRows = input.rows ?? liveSession.rows;
        if (!liveSession.process) {
          yield* flushPtyOutput(liveSession.threadId, liveSession.terminalId);
          if (liveSession.restartPreparation) yield* prepareTerminalRestart(liveSession);
          yield* stopProcess(liveSession);
          liveSession.executionTargetId = executionTargetId;
          liveSession.dropPathMode = defaultTerminalDropPathMode(executionTargetId);
          liveSession.cwd = input.cwd;
          liveSession.worktreePath = input.worktreePath ?? null;
          liveSession.runtimeEnv = nextRuntimeEnv;
          liveSession.directoryFallback = folder.directoryFallback;
          liveSession.wslIdentity = folder.wslIdentity;
          resetSessionRuntimeState(liveSession);
          yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
        }

        if (!liveSession.process) {
          yield* acquireWorktreeLease({
            runtimePathIdentity: folder.runtimePathIdentity,
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            cwd: input.cwd,
            worktreePath: liveSession.worktreePath,
          });
          yield* startSession(
            liveSession,
            {
              threadId: input.threadId,
              terminalId,
              executionTargetId,
              cwd: input.cwd,
              worktreePath: liveSession.worktreePath,
              cols: targetCols,
              rows: targetRows,
              ...(input.env ? { env: input.env } : {}),
            },
            "started",
          ).pipe(
            Effect.onError(() => releaseWorktreeLease({ threadId: input.threadId, terminalId })),
          );
          if (liveSession.pid !== null) {
            yield* markWorktreeLeaseStarted({
              threadId: input.threadId,
              terminalId,
              processId: liveSession.pid,
            });
          }
          return snapshot(liveSession);
        }

        if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
          liveSession.cols = targetCols;
          liveSession.rows = targetRows;
          liveSession.updatedAt = nextTerminalTimestamp(liveSession.updatedAt);
          liveSession.process.resize(targetCols, targetRows);
        }

        return snapshot(liveSession);
      }),
    );

  const { write, resize } = makeTerminalSessionControls(requireSession);

  const clear: TerminalManagerShape["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const session = yield* requireSession(input.threadId, terminalId);
        yield* flushPtyOutput(input.threadId, terminalId);
        resetSessionRuntimeState(session);
        session.updatedAt = nextTerminalTimestamp(session.updatedAt);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          createdAt: session.updatedAt,
        });
      }),
    );

  const restart: TerminalManagerShape["restart"] = (request) =>
    withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = request.terminalId ?? DEFAULT_TERMINAL_ID;
        const executionTargetId = resolveExecutionTargetId(request.executionTargetId);
        const folder = yield* resolveFolder({
          threadId: request.threadId,
          terminalId,
          executionTargetId,
          cwd: request.cwd,
          worktreePath: request.worktreePath,
          env: request.env,
        });
        const input = {
          ...request,
          cwd: folder.cwd,
          ...(folder.wslIdentity ? { worktreePath: folder.worktreePath, env: folder.env } : {}),
          ...(folder.directoryFallback ? { worktreePath: null, env: undefined } : {}),
        };
        const sessionKey = toSessionKey(input.threadId, terminalId);
        const existingSession = yield* getSession(input.threadId, terminalId);
        let session: TerminalSessionState;
        if (Option.isNone(existingSession)) {
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          session = createTerminalSessionState({
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            dropPathMode: defaultTerminalDropPathMode(executionTargetId),
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            history: "",
            cols,
            rows,
            runtimeEnv: normalizedRuntimeEnv(input.env),
          });
          const createdSession = session;
          session.remoteOwnerRecoveryRequired = yield* ctx.historyExists(
            input.threadId,
            terminalId,
          );
          yield* modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [undefined, { ...state, sessions }] as const;
          });
          yield* evictInactiveSessionsIfNeeded();
        } else {
          session = existingSession.value;
          yield* flushPtyOutput(session.threadId, session.terminalId);
          yield* prepareTerminalRestart(session);
          yield* stopProcess(session);
          session.executionTargetId = executionTargetId;
          session.dropPathMode = defaultTerminalDropPathMode(executionTargetId);
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
        }

        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;
        session.directoryFallback = folder.directoryFallback;
        session.wslIdentity = folder.wslIdentity;
        resetSessionRuntimeState(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* acquireWorktreeLease({
          runtimePathIdentity: folder.runtimePathIdentity,
          threadId: input.threadId,
          terminalId,
          executionTargetId,
          cwd: input.cwd,
          worktreePath: session.worktreePath,
        });
        yield* startSession(
          session,
          {
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            cwd: input.cwd,
            ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
            cols,
            rows,
            ...(input.env ? { env: input.env } : {}),
          },
          "restarted",
        ).pipe(
          Effect.onError(() => releaseWorktreeLease({ threadId: input.threadId, terminalId })),
        );
        if (session.pid !== null) {
          yield* markWorktreeLeaseStarted({
            threadId: input.threadId,
            terminalId,
            processId: session.pid,
          });
        }
        return snapshot(session);
      }),
    );

  const close = makeTerminalClose(ctx);
  const searchIndex = new TerminalSearchIndex();

  return {
    hasActiveThread: (threadId) =>
      sessionsForThread(threadId).pipe(
        Effect.map((sessions) =>
          sessions.some((session) => session.status === "running" || session.hasRunningSubprocess),
        ),
      ),
    open,
    snapshot: (input) =>
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const session = yield* requireSession(input.threadId, terminalId);
        if (session.status !== "running" || !session.process) {
          return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
        }
        return snapshot(session);
      }),
    write,
    resize,
    clear,
    restart,
    close,
    subscribe: (listener, options) =>
      subscribeToTerminalEvents(
        { modifyManagerState, terminalEventListeners, getSession },
        listener,
        options,
      ),
    setOutputHold: makeTerminalOutputHold(getSession),
    search: (input) =>
      modifyManagerState((state) => [Array.from(state.sessions.values()), state] as const).pipe(
        Effect.map((sessions) => searchIndex.search(sessions, input)),
      ),
  };
}
