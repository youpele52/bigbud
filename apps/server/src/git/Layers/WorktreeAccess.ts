import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import { makeWorktreeReservations } from "./WorktreeReservations.ts";
import { assertInactiveWorktreeThread, listWorktreeReferences } from "./WorktreeReferences.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";

/** Short app-owned filesystem/Git admission using the same durable reservation table. */
export function withWorktreeAccess<A, E>(
  sql: SqlClient.SqlClient,
  input: {
    readonly cwd: string;
    readonly repository: string;
    readonly blocksRuntime?: boolean;
    readonly isPhysicallySettled?: () => boolean;
  },
  run: Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const identity = yield* Effect.tryPromise({
      try: () => captureWorktreePathIdentity(input.cwd),
      catch: (cause) => worktreeFailure(input.cwd, "Workspace identity is unavailable.", cause),
    });
    const id = `workspace-access-${crypto.randomUUID()}`;
    const reservations = makeWorktreeReservations(sql);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const operations = yield* reservations.pending();
        if (
          operations.some(
            (operation) =>
              operation.kind !== "access" &&
              (operation.repository === input.repository ||
                reservations.overlaps(operation, identity.canonicalPath)),
          )
        )
          return yield* worktreeFailure(
            input.cwd,
            "workspace_busy: worktree operation owns this workspace. Nothing was dispatched.",
          );
        if (input.blocksRuntime) {
          for (const reference of yield* listWorktreeReferences(
            sql,
            identity.canonicalPath,
            undefined,
            identity,
          ))
            yield* assertInactiveWorktreeThread(sql, reference.threadId);
          const leases =
            yield* sql`SELECT 1 FROM worktree_runtime_leases WHERE canonical_path = ${identity.canonicalPath} OR (device = ${identity.device} AND inode = ${identity.inode}) LIMIT 1`;
          if (leases.length)
            return yield* worktreeFailure(
              input.cwd,
              "Stop the active workspace runtime before changing its checkout.",
            );
        }
        yield* sql`INSERT INTO worktree_operations(operation_id,request_digest,kind,repository,cwd,source_path,destination_path,canonical_path,device,inode,branch,phase,created_at)
        VALUES (${id},${id},'access',${input.repository},${input.cwd},${input.cwd},${input.cwd},${identity.canonicalPath},${identity.device},${identity.inode},${input.blocksRuntime ? "workspace-mutation" : null},'dispatched',${new Date().toISOString()})`;
      }),
    );
    // An interrupted effect retains its reservation: cancellation is not proof that physical work exited.
    const result = yield* run.pipe(Effect.result);
    if (input.isPhysicallySettled?.() === false) {
      yield* sql`UPDATE worktree_operations SET phase = 'recovery-required', error = 'Physical operation exit is unconfirmed' WHERE operation_id = ${id}`;
    } else
      yield* sql`DELETE FROM worktree_operations WHERE operation_id = ${id} AND kind = 'access'`;
    if (result._tag === "Failure") return yield* Effect.fail(result.failure);
    return result.success;
  });
}

/** Observations do not reserve or block session admission. Unknown commands fail conservatively. */
export function gitNeedsWorkspaceReservation(args: readonly string[]): boolean {
  const command = args[0];
  if (
    [
      "status",
      "diff",
      "diff-tree",
      "log",
      "show",
      "rev-parse",
      "rev-list",
      "for-each-ref",
      "ls-files",
      "ls-tree",
      "check-ignore",
      "merge-base",
      "cat-file",
    ].includes(command ?? "")
  )
    return false;
  if (command === "worktree" && args[1] === "list") return false;
  if (
    command === "branch" &&
    args
      .slice(1)
      .some((arg) => ["--list", "--show-current", "--format"].some((flag) => arg.startsWith(flag)))
  )
    return false;
  if (
    command === "config" &&
    args.slice(1).some((arg) => ["--get", "--get-all", "--get-regexp", "--list"].includes(arg))
  )
    return false;
  return command !== "init";
}
