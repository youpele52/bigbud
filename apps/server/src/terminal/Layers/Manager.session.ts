import {
  DEFAULT_TERMINAL_ID,
  TerminalExecutionTargetError,
  resolveExecutionTargetId,
} from "@bigbud/contracts";
import { Effect, Equal, Option } from "effect";

import { increment, terminalRestartsTotal } from "../../observability/Metrics";
import { TerminalNotRunningError } from "../Services/Manager";
import { defaultTerminalDropPathMode, normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS } from "./Manager.types";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { assertSshExecutionTargetReady } from "../../ssh/sshVerification.ts";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state.ts";
import { type SessionApiContext, type TerminalManagerShape } from "./Manager.session.types.ts";
import { type TerminalSessionState } from "./Manager.types";

// ---------------------------------------------------------------------------
// API method builders
// ---------------------------------------------------------------------------

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
    readHistory,
    deleteHistory,
    deleteAllHistoryForThread,
    evictInactiveSessionsIfNeeded,
    assertValidCwd,
    publishEvent,
    snapshot,
    terminalEventListeners,
  } = ctx;

  const assertExecutionTargetReady = (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly executionTargetId: string;
    readonly cwd: string;
  }) =>
    isLocalExecutionTarget(input.executionTargetId)
      ? assertValidCwd(input.cwd)
      : Effect.try({
          try: () => assertSshExecutionTargetReady(input.executionTargetId),
          catch: (cause) =>
            new TerminalExecutionTargetError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              executionTargetId: input.executionTargetId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });

  const open: TerminalManagerShape["open"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
        yield* assertExecutionTargetReady({
          threadId: input.threadId,
          terminalId,
          executionTargetId,
          cwd: input.cwd,
        });

        const sessionKey = toSessionKey(input.threadId, terminalId);
        const existing = yield* getSession(input.threadId, terminalId);
        if (Option.isNone(existing)) {
          yield* flushPtyOutput(input.threadId, terminalId);
          yield* flushPersist(input.threadId, terminalId);
          const history = yield* readHistory(input.threadId, terminalId);
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          const session = createTerminalSessionState({
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            dropPathMode: defaultTerminalDropPathMode(executionTargetId),
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            history,
            cols,
            rows,
            runtimeEnv: normalizedRuntimeEnv(input.env),
          });

          const createdSession = session;
          yield* modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [undefined, { ...state, sessions }] as const;
          });

          yield* evictInactiveSessionsIfNeeded();
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
          );
          return snapshot(session);
        }

        const liveSession = existing.value;
        const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
        const currentRuntimeEnv = liveSession.runtimeEnv;
        const targetCols = input.cols ?? liveSession.cols;
        const targetRows = input.rows ?? liveSession.rows;
        const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
        const executionTargetChanged = liveSession.executionTargetId !== executionTargetId;

        if (liveSession.cwd !== input.cwd || runtimeEnvChanged || executionTargetChanged) {
          yield* flushPtyOutput(liveSession.threadId, liveSession.terminalId);
          yield* stopProcess(liveSession);
          liveSession.executionTargetId = executionTargetId;
          liveSession.dropPathMode = defaultTerminalDropPathMode(executionTargetId);
          liveSession.cwd = input.cwd;
          liveSession.worktreePath = input.worktreePath ?? null;
          liveSession.runtimeEnv = nextRuntimeEnv;
          resetSessionRuntimeState(liveSession);
          yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
        } else if (liveSession.status === "exited" || liveSession.status === "error") {
          yield* flushPtyOutput(liveSession.threadId, liveSession.terminalId);
          liveSession.executionTargetId = executionTargetId;
          liveSession.dropPathMode = defaultTerminalDropPathMode(executionTargetId);
          liveSession.runtimeEnv = nextRuntimeEnv;
          liveSession.worktreePath = input.worktreePath ?? null;
          resetSessionRuntimeState(liveSession);
          yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
        }

        if (!liveSession.process) {
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
          );
          return snapshot(liveSession);
        }

        if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
          liveSession.cols = targetCols;
          liveSession.rows = targetRows;
          liveSession.updatedAt = new Date().toISOString();
          liveSession.process.resize(targetCols, targetRows);
        }

        return snapshot(liveSession);
      }),
    );

  const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const session = yield* requireSession(input.threadId, terminalId);
    const proc = session.process;
    if (!proc || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    }
    yield* Effect.sync(() => proc.write(input.data));
  });

  const resize: TerminalManagerShape["resize"] = Effect.fn("terminal.resize")(function* (input) {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const session = yield* requireSession(input.threadId, terminalId);
    const proc = session.process;
    if (!proc || session.status !== "running") {
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    yield* Effect.sync(() => proc.resize(input.cols, input.rows));
  });

  const clear: TerminalManagerShape["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const session = yield* requireSession(input.threadId, terminalId);
        yield* flushPtyOutput(input.threadId, terminalId);
        resetSessionRuntimeState(session);
        session.updatedAt = new Date().toISOString();
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
        });
      }),
    );

  const restart: TerminalManagerShape["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const executionTargetId = resolveExecutionTargetId(input.executionTargetId);
        yield* assertExecutionTargetReady({
          threadId: input.threadId,
          terminalId,
          executionTargetId,
          cwd: input.cwd,
        });

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
          yield* modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(sessionKey, createdSession);
            return [undefined, { ...state, sessions }] as const;
          });
          yield* evictInactiveSessionsIfNeeded();
        } else {
          session = existingSession.value;
          yield* flushPtyOutput(session.threadId, session.terminalId);
          yield* stopProcess(session);
          session.executionTargetId = executionTargetId;
          session.dropPathMode = defaultTerminalDropPathMode(executionTargetId);
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
        }

        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;

        resetSessionRuntimeState(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
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
        );
        return snapshot(session);
      }),
    );

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);

    if (Option.isSome(session)) {
      yield* flushPtyOutput(threadId, terminalId);
      yield* stopProcess(session.value);
      yield* persistHistory(threadId, terminalId, session.value.history);
    }

    yield* flushPersist(threadId, terminalId);

    yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [undefined, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [undefined, { ...state, sessions }] as const;
    });

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const close: TerminalManagerShape["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        yield* Effect.forEach(
          threadSessions,
          (session) => closeSession(input.threadId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  return {
    open,
    write,
    resize,
    clear,
    restart,
    close,
    subscribe: (listener) =>
      Effect.sync(() => {
        terminalEventListeners.add(listener);
        return () => {
          terminalEventListeners.delete(listener);
        };
      }),
  };
}
