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
import { makeResolveTerminalFolder, type ResolvedTerminalFolder } from "./Manager.cwd";
import { prepareTerminalRestart } from "./Manager.session.restart";
import { reattachRunningTerminalSession } from "./Manager.session.open.reattach.ts";
import {
  endedTerminalSnapshot,
  hostLostPane,
  openTerminalAttachOnly,
  rejectTerminalHostLimit,
} from "./Manager.session.open.host.ts";
import { resolveTerminalEvictLifecycle } from "./Manager.hostLimit.ts";
import { terminalHostClosedSession } from "./Manager.hostLifecycle.ts";
import { sessionOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import {
  findNativeTerminalHostLoss,
  findNativeTerminalRecovery,
  resolveOwnedTerminalRecoverOnly,
} from "./OwnedPtyRuntime.owner.ts";
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
    ctx.directSshCwdOwner,
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
        if (Option.isSome(existing) && existing.value.process)
          return yield* reattachRunningTerminalSession({
            ctx,
            session: existing.value,
            request,
            terminalId,
            expectedRemoteResourceId,
            unconfirmed,
          });
        // A pane the host closed (idle, memory, limit, orphan) is gone: never respawn it (§11.1).
        if (Option.isSome(existing) && terminalHostClosedSession(existing.value))
          return snapshot(existing.value);
        const closedReason = Option.isNone(existing)
          ? ctx.hostClosed?.find(request.threadId, terminalId)
          : undefined;
        if (closedReason) return endedTerminalSnapshot(ctx, request, terminalId, closedReason);
        const executionTargetId = resolveExecutionTargetId(request.executionTargetId);
        const ownedRuntime = sessionOwnedPtyRuntime(ctx, executionTargetId);
        const lost = yield* findNativeTerminalHostLoss(ownedRuntime, request.threadId, terminalId);
        if (lost) {
          if (expectedRemoteResourceId && lost.resourceId !== expectedRemoteResourceId)
            return yield* unconfirmed();
          return endedTerminalSnapshot(
            ctx,
            request,
            terminalId,
            "host-lost",
            yield* ctx.readHistory(request.threadId, terminalId),
          );
        }
        const attachOnly = () =>
          openTerminalAttachOnly({ ctx, request, terminalId, executionTargetId, existing });
        // A restored pane whose PTY the host lost opens read-only with its cold screen.
        if (request.attachOnly && Option.isNone(existing) && hostLostPane(ctx, request, terminalId))
          return yield* attachOnly();
        const nativeRecovery = yield* findNativeTerminalRecovery(
          ownedRuntime,
          request,
          terminalId,
        ).pipe(Effect.mapError(unconfirmed));
        if (
          nativeRecovery &&
          expectedRemoteResourceId &&
          nativeRecovery.resourceId !== expectedRemoteResourceId
        )
          return yield* unconfirmed();
        const recoveryLease = nativeRecovery?.resourceId ?? expectedRemoteResourceId;
        const recoverOnly =
          Boolean(recoveryLease) ||
          (yield* resolveOwnedTerminalRecoverOnly({
            runtime: ownedRuntime,
            threadId: request.threadId,
            terminalId,
            existing,
            historyExists: ctx.historyExists,
          }));
        // Attach-only never spawns (plan D1): only a retained owner may be reattached.
        if (request.attachOnly && !recoverOnly) return yield* attachOnly();
        const hostLifecycle = yield* resolveTerminalEvictLifecycle({
          evict: request.evict,
          sessions: () => ctx.hostLimit?.sessions() ?? Effect.succeed([]),
          runtime: sessionOwnedPtyRuntime(ctx, executionTargetId),
        });
        yield* assertDirectShellLaunchAvailable(ctx.directShellOwners, {
          threadId: request.threadId,
          terminalId,
          executionTargetId,
        });
        const folder: ResolvedTerminalFolder = nativeRecovery
          ? { cwd: request.cwd }
          : yield* resolveFolder({
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
          session.expectedRemoteResourceId = recoveryLease;
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
              ...(hostLifecycle ? { hostLifecycle } : {}),
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
          if (session.hostLimitRefusal)
            return yield* rejectTerminalHostLimit({ ctx, session, created: true });
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
        if (recoveryLease) {
          liveSession.expectedRemoteResourceId = recoveryLease;
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
              ...(hostLifecycle ? { hostLifecycle } : {}),
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
          if (liveSession.hostLimitRefusal)
            return yield* rejectTerminalHostLimit({ ctx, session: liveSession, created: false });
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
    // Bound the whole queued recovery, including warm confirmation and cold attachment.
    return expectedRemoteResourceId
      ? operation.pipe(
          Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.fail(unconfirmed()) }),
        )
      : operation;
  };

  return open;
}
