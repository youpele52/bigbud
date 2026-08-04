import { TerminalCwdError } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { ServerConfig } from "../../startup/config";
import { TerminalManager } from "../Services/Manager";
import { PtyAdapter } from "../Services/PTY";
import { makeTerminalManagerWithOptions } from "./Manager.process";
import {
  captureLocalRuntimePathIdentity,
  reconcileWorktreeRuntimeLeases,
} from "../../retention/worktreeRuntimeLease.ts";

export { makeTerminalManagerWithOptions } from "./Manager.process";

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  const sql = yield* SqlClient.SqlClient;
  yield* reconcileWorktreeRuntimeLeases(sql, "terminal");
  const acquireWorktreeLease = Effect.fn("terminal.acquireWorktreeLease")(function* (input: {
    threadId: string;
    terminalId: string;
    executionTargetId: string;
    cwd: string;
    worktreePath: string | null;
  }) {
    if (!isLocalExecutionTarget(input.executionTargetId)) {
      return;
    }
    const identity = yield* Effect.tryPromise({
      try: () => captureLocalRuntimePathIdentity(input.worktreePath ?? input.cwd),
      catch: (cause) =>
        new TerminalCwdError({
          cwd: input.worktreePath ?? input.cwd,
          reason: "statFailed",
          cause,
        }),
    });
    yield* sql`
      INSERT INTO worktree_runtime_leases (
        lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at
      ) VALUES (
        ${`terminal:${input.threadId}:${input.terminalId}`}, ${input.threadId}, 'terminal',
        ${identity.canonicalPath}, ${identity.device}, ${identity.inode},
        ${new Date().toISOString()}, ${new Date().toISOString()}
      ) ON CONFLICT (lease_id) DO UPDATE SET
        canonical_path = excluded.canonical_path, device = excluded.device,
        inode = excluded.inode, updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new TerminalCwdError({
            cwd: input.worktreePath ?? input.cwd,
            reason: "statFailed",
            cause,
          }),
      ),
    );
  });
  const releaseWorktreeLease = (input: { threadId: string; terminalId: string }) =>
    sql`DELETE FROM worktree_runtime_leases
      WHERE lease_id = ${`terminal:${input.threadId}:${input.terminalId}`}`.pipe(
      Effect.asVoid,
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
    ptyAdapter,
    acquireWorktreeLease,
    markWorktreeLeaseStarted,
    releaseWorktreeLease,
  });
});

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
