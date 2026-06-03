import {
  DEFAULT_TERMINAL_ID,
  TerminalExecutionTargetError,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  resolveExecutionTargetId,
} from "@bigbud/contracts";
import { Effect, Equal, Option } from "effect";

import { increment, terminalRestartsTotal } from "../../observability/Metrics";
import {
  TerminalCwdError,
  TerminalNotRunningError,
  TerminalSessionLookupError,
  type TerminalManagerShape,
} from "../Services/Manager";
import { normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import {
  DEFAULT_OPEN_COLS,
  DEFAULT_OPEN_ROWS,
  type TerminalManagerState,
  type TerminalSessionState,
  type TerminalStartInput,
} from "./Manager.types";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { assertSshExecutionTargetReady } from "../../ssh/sshVerification.ts";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state.ts";

export interface SessionApiContext {
  publishEvent: (event: TerminalEvent) => Effect.Effect<void>;
  modifyManagerState: <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => Effect.Effect<A>;
  getSession: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<Option.Option<TerminalSessionState>>;
  requireSession: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<TerminalSessionState, TerminalSessionLookupError>;
  sessionsForThread: (threadId: string) => Effect.Effect<TerminalSessionState[]>;
  withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  stopProcess: (session: TerminalSessionState) => Effect.Effect<void>;
  startSession: (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) => Effect.Effect<void>;
  flushPtyOutput: (threadId: string, terminalId: string) => Effect.Effect<void>;
  persistHistory: (threadId: string, terminalId: string, history: string) => Effect.Effect<void>;
  flushPersist: (threadId: string, terminalId: string) => Effect.Effect<void>;
  readHistory: (threadId: string, terminalId: string) => Effect.Effect<string>;
  deleteHistory: (threadId: string, terminalId: string) => Effect.Effect<void>;
  deleteAllHistoryForThread: (threadId: string) => Effect.Effect<void>;
  evictInactiveSessionsIfNeeded: () => Effect.Effect<void>;
  assertValidCwd: (cwd: string) => Effect.Effect<void, TerminalCwdError>;
  snapshot: (session: TerminalSessionState) => TerminalSessionSnapshot;
  terminalEventListeners: Set<(event: TerminalEvent) => Effect.Effect<void>>;
}

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

        if (liveSession.cwd !== input.cwd || runtimeEnvChanged) {
          yield* flushPtyOutput(liveSession.threadId, liveSession.terminalId);
          yield* stopProcess(liveSession);
          liveSession.executionTargetId = executionTargetId;
          liveSession.cwd = input.cwd;
          liveSession.worktreePath = input.worktreePath ?? null;
          liveSession.runtimeEnv = nextRuntimeEnv;
          resetSessionRuntimeState(liveSession);
          yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
        } else if (liveSession.status === "exited" || liveSession.status === "error") {
          yield* flushPtyOutput(liveSession.threadId, liveSession.terminalId);
          liveSession.executionTargetId = executionTargetId;
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
