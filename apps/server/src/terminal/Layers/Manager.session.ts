import { DEFAULT_TERMINAL_ID, resolveExecutionTargetId } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isLocalExecutionTarget } from "../../executionTargets";
import { localShellDefaultsEnabled } from "../../constants/terminalShells";

import { makeTerminalRestart } from "./Manager.session.restart.action";
import { makeTerminalSessionControls } from "./Manager.session.controls.ts";
import { defaultTerminalDropPathMode, normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS } from "./Manager.types";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state.ts";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { subscribeToTerminalEvents } from "./Manager.session.subscription.ts";
import { type SessionApiContext, type TerminalManagerShape } from "./Manager.session.types.ts";
import { makeResolveTerminalFolder } from "./Manager.cwd";
import { makeTerminalClose } from "./Manager.session.close";
import { prepareTerminalRestart } from "./Manager.session.restart";
import { makeTerminalOutputHold } from "./Manager.session.outputHold";
import { TerminalSearchIndex } from "./Manager.search";
import { resizeWithRecovery } from "./Manager.recovery";
import { captureTerminalRecovery } from "./Manager.recoveryRpc";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { makeListTerminalShellProfiles } from "./Manager.shell.inventory";
import { resolveTerminalRemoteShellIntent } from "./Manager.shell.intent";
import {
  assertDirectShellLaunchAvailable,
  preflightDirectShellLaunch,
} from "./Manager.shell.direct";
import { prepareTerminalLaunchHistory } from "./Manager.session.history";
import {
  assertTerminalShellReattach,
  makeResolveTerminalShellProfile,
  terminalShellSelectionForNewProcess,
} from "./Manager.shell.profile";

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

  const resolveShellProfile = makeResolveTerminalShellProfile(
    ctx.resolveShellProfile,
    ctx.preflightRemoteShellProfile,
    ctx.directShellOwners,
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
          yield* assertTerminalShellReattach(
            session,
            resolveExecutionTargetId(request.executionTargetId),
            request.shellSelection,
          );
          const cols = request.cols ?? session.cols;
          const rows = request.rows ?? session.rows;
          if (session.cols !== cols || session.rows !== rows) {
            session.cols = cols;
            session.rows = rows;
            session.updatedAt = nextTerminalTimestamp(session.updatedAt);
            const process = session.process!;
            // Reattach must not fail on a resize race with a process that is exiting.
            const resizeError = yield* Effect.sync(() => {
              try {
                resizeWithRecovery(session, process, cols, rows);
                return null;
              } catch (cause) {
                return cause instanceof Error ? cause.message : String(cause);
              }
            });
            if (resizeError !== null) {
              yield* Effect.logDebug("terminal reattach resize failed", {
                threadId: session.threadId,
                terminalId,
                error: resizeError,
              });
            }
          }
          return snapshot(session);
        }
        const executionTargetId = resolveExecutionTargetId(request.executionTargetId);
        const recoverOnly =
          isRemoteAgentExecutionTarget(executionTargetId) &&
          (Option.isSome(existing)
            ? existing.value.remoteOwnerRecoveryRequired === true
            : yield* ctx.historyExists(request.threadId, terminalId));
        yield* assertDirectShellLaunchAvailable(ctx.directShellOwners, {
          threadId: request.threadId,
          terminalId,
          executionTargetId,
        });
        const folder = yield* resolveFolder({
          threadId: request.threadId,
          terminalId,
          executionTargetId,
          cwd: request.cwd,
          worktreePath: request.worktreePath,
          env: request.env,
        });
        const localDefault =
          !request.shellSelection &&
          Option.isNone(existing) &&
          isLocalExecutionTarget(executionTargetId) &&
          localShellDefaultsEnabled()
            ? ctx.getLocalShellDefault?.()
            : undefined;
        const newDefault =
          localDefault?.kind === "profile" &&
          !(yield* ctx.historyExists(request.threadId, terminalId))
            ? localDefault
            : undefined;
        const shellProfileLaunch = recoverOnly
          ? null
          : yield* resolveShellProfile({
              threadId: request.threadId,
              terminalId,
              executionTargetId,
              wslIdentity: folder.wslIdentity,
              selection: yield* terminalShellSelectionForNewProcess({
                threadId: request.threadId,
                terminalId,
                executionTargetId,
                selection: request.shellSelection ?? newDefault,
                existing: Option.getOrUndefined(existing),
              }),
            });
        yield* preflightDirectShellLaunch(ctx.directShellOwners, {
          threadId: request.threadId,
          terminalId,
          executionTargetId,
          cwd: folder.cwd,
          wslIdentity: folder.wslIdentity,
          launch: shellProfileLaunch,
        });
        yield* resolveTerminalRemoteShellIntent({
          threadId: request.threadId,
          terminalId,
          executionTargetId,
          cwd: folder.cwd,
          launch: shellProfileLaunch,
          recoverOnly,
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
          session.remoteOwnerRecoveryRequired = recoverOnly;
          if (recoverOnly) session.history = yield* ctx.readHistory(input.threadId, terminalId);
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
              shellProfileLaunch,
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
          if (recoverOnly && session.process)
            yield* assertTerminalShellReattach(session, executionTargetId, request.shellSelection);
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
          const restoreFailedHistory = prepareTerminalLaunchHistory(liveSession, recoverOnly);
          yield* startSession(
            liveSession,
            {
              threadId: input.threadId,
              terminalId,
              executionTargetId,
              shellProfileLaunch,
              cwd: input.cwd,
              worktreePath: liveSession.worktreePath,
              cols: targetCols,
              rows: targetRows,
              ...(input.env ? { env: input.env } : {}),
            },
            "started",
          ).pipe(
            Effect.onError(() => releaseWorktreeLease({ threadId: input.threadId, terminalId })),
            Effect.ensuring(Effect.sync(restoreFailedHistory)),
          );
          yield* persistHistory(input.threadId, terminalId, liveSession.history);
          if (recoverOnly && liveSession.process)
            yield* assertTerminalShellReattach(
              liveSession,
              executionTargetId,
              request.shellSelection,
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

  const restart = makeTerminalRestart(ctx);

  const close = makeTerminalClose(ctx);
  const searchIndex = new TerminalSearchIndex();

  return {
    hasActiveThread: (threadId) =>
      sessionsForThread(threadId).pipe(
        Effect.map((sessions) =>
          sessions.some((session) => session.status === "running" || session.hasRunningSubprocess),
        ),
      ),
    listExecutionTargetSessions: (executionTargetId) =>
      modifyManagerState((state) => [Array.from(state.sessions.values()), state] as const).pipe(
        Effect.map((sessions) =>
          sessions
            .filter((session) => session.executionTargetId === executionTargetId)
            .map(({ threadId, terminalId }) => ({ threadId, terminalId })),
        ),
      ),
    open,
    listShellProfiles: makeListTerminalShellProfiles(ctx),
    // Retained lifecycle/identity is authoritative even after exit or a failed launch.
    snapshot: (input) =>
      requireSession(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID).pipe(
        Effect.map(snapshot),
      ),
    recovery: (input) =>
      requireSession(input.threadId, input.terminalId).pipe(
        Effect.flatMap((session) => captureTerminalRecovery(session, input)),
      ),
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
