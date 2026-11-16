import { DEFAULT_TERMINAL_ID, resolveExecutionTargetId } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { isLocalExecutionTarget } from "../../executionTargets";
import { localShellDefaultsEnabled } from "../../constants/terminalShells";

import { defaultTerminalDropPathMode, normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS } from "./Manager.types";
import { createTerminalSessionState } from "./Manager.session.state.ts";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { type SessionApiContext, type TerminalManagerShape } from "./Manager.session.types.ts";
import { makeResolveTerminalFolder } from "./Manager.cwd";
import { prepareTerminalRestart } from "./Manager.session.restart";
import { resizeWithRecovery } from "./Manager.recovery";
import { sessionOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import { releaseTerminalLeaseAfterLaunchFailure } from "./Manager.owned-runtime.lease.ts";
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

import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";

export function makeTerminalOpen(ctx: SessionApiContext) {
  const {
    withThreadLock,
    getSession,
    modifyManagerState,
    stopProcess,
    startSession,
    flushPtyOutput,
    persistHistory,
    flushPersist,
    evictInactiveSessionsIfNeeded,
    assertValidCwd,
    snapshot,
    acquireWorktreeLease,
    markWorktreeLeaseStarted,
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

  const open = (
    request: Parameters<TerminalManagerShape["open"]>[0],
    expectedRemoteResourceId?: string,
  ): ReturnType<TerminalManagerShape["open"]> => {
    const unconfirmed = () =>
      new TerminalExecutionTargetError({
        threadId: request.threadId,
        terminalId: request.terminalId ?? DEFAULT_TERMINAL_ID,
        executionTargetId: resolveExecutionTargetId(request.executionTargetId),
        detail:
          "Remote terminal recovery is unconfirmed. Its process was not restarted. Check SSH access; the project menu’s Reconnect action can request a managed service restart.",
      });
    const operation = withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        const terminalId = request.terminalId ?? DEFAULT_TERMINAL_ID;
        const existing = yield* getSession(request.threadId, terminalId);
        // Open means reattach, never reinterpret mutable chat launch settings as a restart.
        if (Option.isSome(existing) && existing.value.process) {
          const session = existing.value;
          if (
            expectedRemoteResourceId &&
            session.process?.remoteResourceId !== expectedRemoteResourceId
          )
            return yield* new TerminalExecutionTargetError({
              threadId: request.threadId,
              terminalId,
              executionTargetId: session.executionTargetId,
              detail: "Discovered terminal identity changed. Refresh discovery before attaching.",
            });
          yield* assertTerminalShellReattach(
            session,
            resolveExecutionTargetId(request.executionTargetId),
            request.shellSelection,
            ctx,
          );
          const process = session.process!;
          const runtimeEpoch = session.runtimeEpoch;
          if (process.reconnectRemote) {
            // Bound this caller's wait, not the shared same-identity reconnect
            // episode. A late completion must not retain the thread lock or
            // continue this open into resize/snapshot/launch work.
            yield* Effect.tryPromise({
              try: (signal) => process.reconnectRemote!(signal),
              catch: unconfirmed,
            }).pipe(
              Effect.timeoutOrElse({
                duration: 15_000,
                orElse: () => Effect.fail(unconfirmed()),
              }),
            );
            if (
              session.process !== process ||
              session.runtimeEpoch !== runtimeEpoch ||
              session.observedExit?.process === process
            )
              return yield* unconfirmed();
            session.pid = process.pid;
            session.status = "running";
            session.updatedAt = nextTerminalTimestamp(session.updatedAt);
          }
          const cols = request.cols ?? session.cols;
          const rows = request.rows ?? session.rows;
          if (session.cols !== cols || session.rows !== rows) {
            session.cols = cols;
            session.rows = rows;
            session.updatedAt = nextTerminalTimestamp(session.updatedAt);
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
          Boolean(expectedRemoteResourceId) ||
          (Boolean(sessionOwnedPtyRuntime(ctx, executionTargetId)) &&
            (Option.isSome(existing)
              ? existing.value.remoteOwnerRecoveryRequired === true
              : yield* ctx.historyExists(request.threadId, terminalId)));
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
          session.expectedRemoteResourceId = expectedRemoteResourceId;
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
            Effect.onError(() =>
              releaseTerminalLeaseAfterLaunchFailure(ctx, {
                threadId: input.threadId,
                terminalId,
                executionTargetId,
              }),
            ),
          );
          if (recoverOnly && session.process)
            yield* assertTerminalShellReattach(
              session,
              executionTargetId,
              request.shellSelection,
              ctx,
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
        if (expectedRemoteResourceId) {
          liveSession.expectedRemoteResourceId = expectedRemoteResourceId;
          liveSession.remoteOwnerRecoveryRequired = true;
        }
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
            Effect.onError(() =>
              releaseTerminalLeaseAfterLaunchFailure(ctx, {
                threadId: input.threadId,
                terminalId,
                executionTargetId,
              }),
            ),
            Effect.ensuring(Effect.sync(restoreFailedHistory)),
          );
          yield* persistHistory(input.threadId, terminalId, liveSession.history);
          if (recoverOnly && liveSession.process)
            yield* assertTerminalShellReattach(
              liveSession,
              executionTargetId,
              request.shellSelection,
              ctx,
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
    // A queued caller owns its own deadline; it must not wait another full
    // recovery budget after acquiring the thread lock. Cancellation reaches
    // both warm confirmation and provisional cold attachment observers.
    return expectedRemoteResourceId
      ? operation.pipe(
          Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.fail(unconfirmed()) }),
        )
      : operation;
  };

  return open;
}
