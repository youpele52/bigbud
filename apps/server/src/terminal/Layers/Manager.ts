import {
  TerminalCwdError,
  TerminalRuntimeLeaseError,
} from "@bigbud/contracts/workspace/terminal.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../../ws/serverSettings";
import { localShellDefaultsEnabled } from "../../constants/terminalShells";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { ServerConfig } from "../../startup/config";
import { TerminalManager } from "../Services/Manager";
import { PtyAdapter } from "../Services/PTY";
import { ShellLaunchPlanner } from "../Services/ShellLaunchPlanner";
import { ShellProfiles } from "../Services/ShellProfiles";
import { preflightRemoteTerminalShellProfile } from "./Manager.shell.remote";
import { makeDirectShellLaunchOwners } from "../../persistence/Layers/DirectShellLaunchOwners";
import { makeTerminalManagerWithOptions } from "./Manager.process";
import { classifyTerminalRuntimeLeaseError } from "./Manager.leaseError.ts";
import type { RuntimePathIdentity } from "./Manager.types";
import {
  captureLocalRuntimePathIdentity,
  reconcileWorktreeRuntimeLeases,
} from "../../retention/worktreeRuntimeLease.ts";
import {
  holdThreadLease,
  releaseThreadLease,
  threadLeaseExpiresAt,
} from "../../retention/threadLeaseHeartbeat.ts";

export { makeTerminalManagerWithOptions } from "./Manager.process";

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  const shellLaunchPlanner = yield* ShellLaunchPlanner;
  const shellProfiles = yield* ShellProfiles;
  const settings = Option.getOrUndefined(yield* Effect.serviceOption(ServerSettingsService));
  const sql = yield* SqlClient.SqlClient;
  yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
  const acquireWorktreeLease = Effect.fn("terminal.acquireWorktreeLease")(function* (input: {
    runtimePathIdentity?: RuntimePathIdentity | undefined;
    threadId: string;
    terminalId: string;
    executionTargetId: string;
    cwd: string;
    worktreePath: string | null;
  }) {
    if (!isLocalExecutionTarget(input.executionTargetId)) {
      return;
    }
    const identity =
      input.runtimePathIdentity ??
      (yield* Effect.tryPromise({
        try: () => captureLocalRuntimePathIdentity(input.worktreePath ?? input.cwd),
        catch: (cause) =>
          new TerminalCwdError({
            cwd: input.worktreePath ?? input.cwd,
            reason: "statFailed",
            cause,
          }),
      }));
    const leaseId = `terminal:${input.threadId}:${input.terminalId}`;
    yield* sql`
      INSERT INTO worktree_runtime_leases (
        lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at,
        expires_at
      ) VALUES (
        ${leaseId}, ${input.threadId}, 'terminal',
        ${identity.canonicalPath}, ${identity.device}, ${identity.inode},
        ${new Date().toISOString()}, ${new Date().toISOString()}, ${threadLeaseExpiresAt()}
      ) ON CONFLICT (lease_id) DO UPDATE SET
        canonical_path = excluded.canonical_path, device = excluded.device,
        inode = excluded.inode, updated_at = excluded.updated_at, expires_at = excluded.expires_at
    `.pipe(
      Effect.asVoid,
      Effect.tap(() => Effect.sync(() => holdThreadLease(leaseId))),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const cwd = input.worktreePath ?? input.cwd;
          const reason = classifyTerminalRuntimeLeaseError(cause);
          yield* Effect.logError("failed to reserve terminal runtime lease", {
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd,
            reason,
            cause,
          });
          return yield* new TerminalRuntimeLeaseError({ cwd, reason });
        }),
      ),
    );
  });
  const releaseWorktreeLease = (input: { threadId: string; terminalId: string }) =>
    sql`DELETE FROM worktree_runtime_leases
      WHERE lease_id = ${`terminal:${input.threadId}:${input.terminalId}`}`.pipe(
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => releaseThreadLease(`terminal:${input.threadId}:${input.terminalId}`)),
      ),
      Effect.catch(() => Effect.void),
    );
  const markWorktreeLeaseStarted = (input: {
    threadId: string;
    terminalId: string;
    processId: number;
  }) =>
    sql`UPDATE worktree_runtime_leases SET process_id = ${input.processId},
      updated_at = ${new Date().toISOString()}
      WHERE lease_id = ${`terminal:${input.threadId}:${input.terminalId}`}`.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to bind terminal process to worktree lease", {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cause,
        }),
      ),
    );
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    getLocalShellDefault: () =>
      localShellDefaultsEnabled()
        ? settings?.currentSnapshot?.()?.settings.terminalShells.hostDefaults.local
        : undefined,
    listLocalShellProfiles: () => shellProfiles.revalidate({ executionTargetId: "local" }),
    ptyAdapter,
    directShellOwners: yield* makeDirectShellLaunchOwners(),
    listShellProfiles: shellProfiles.list,
    preflightRemoteShellProfile: preflightRemoteTerminalShellProfile,
    resolveShellProfile: (selection, target) =>
      shellLaunchPlanner.resolveProfile({ target, selection }),
    resolveRuntimePathIdentity: (cwd) =>
      Effect.tryPromise({
        try: () => captureLocalRuntimePathIdentity(cwd),
        catch: (cause) => new TerminalCwdError({ cwd, reason: "statFailed", cause }),
      }),
    acquireWorktreeLease,
    markWorktreeLeaseStarted,
    releaseWorktreeLease,
  });
});

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
