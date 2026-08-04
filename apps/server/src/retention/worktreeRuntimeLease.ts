import * as nodeFs from "node:fs/promises";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

function isDefinitelyTerminated(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

export async function captureLocalRuntimePathIdentity(target: string): Promise<{
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}> {
  const before = await nodeFs.lstat(target);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("runtime workspace is not a direct directory");
  }
  const canonicalPath = await nodeFs.realpath(target);
  const canonical = await nodeFs.lstat(canonicalPath);
  const after = await nodeFs.lstat(target);
  if (
    canonical.isSymbolicLink() ||
    !canonical.isDirectory() ||
    before.dev !== canonical.dev ||
    before.ino !== canonical.ino ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error("runtime workspace changed while capturing its identity");
  }
  return { canonicalPath, device: before.dev, inode: before.ino };
}

export async function captureWorktreePathIdentity(target: string): Promise<{
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
}> {
  const canonicalPath = await nodeFs.realpath(target);
  const stats = await nodeFs.lstat(canonicalPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("worktree is not a directory");
  }
  return { canonicalPath, device: stats.dev, inode: stats.ino };
}

export const reconcileWorktreeRuntimeLeases = Effect.fn("reconcileWorktreeRuntimeLeases")(
  function* (sql: SqlClient.SqlClient, runtimeKind: "terminal" | "shell") {
    const rows = yield* sql<{ readonly leaseId: string; readonly processId: number | null }>`
    SELECT lease_id AS "leaseId", process_id AS "processId"
    FROM worktree_runtime_leases WHERE runtime_kind = ${runtimeKind}
  `;
    for (const row of rows) {
      if (row.processId !== null && isDefinitelyTerminated(row.processId)) {
        yield* sql`DELETE FROM worktree_runtime_leases WHERE lease_id = ${row.leaseId}`;
      }
    }
  },
);
