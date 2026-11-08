import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  isLocalExecutionTargetId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { captureWorktreePathIdentity } from "../retention/worktreeRuntimeLease.ts";
import { makeWorktreeReservations } from "../git/Layers/WorktreeReservations.ts";
import { recordedWorktreePathsOverlap } from "../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** Existing SQL runtime admission fence, held from before local folder work through app commit.
 * Native transitions require their own verified saga and are still refused by the inner command
 * preparation until that coordinator is enabled. No migration147 dependency for generic projects.
 */
export function withProjectWorkspaceMutation<A, E>(
  sql: SqlClient.SqlClient,
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  run: Effect.Effect<A, E>,
) {
  const project =
    command.type === "project.reconfigure"
      ? readModel.projects.find((entry) => entry.id === command.projectId)
      : undefined;
  if (
    command.type !== "project.reconfigure" ||
    !project?.workspaceRoot ||
    !command.workspaceRoot ||
    project.workspaceRoot === command.workspaceRoot ||
    !isLocalExecutionTargetId(project.workspaceExecutionTargetId ?? project.executionTargetId) ||
    !isLocalExecutionTargetId(command.workspaceExecutionTargetId)
  )
    return run;
  const sourcePath = project.workspaceRoot;
  const destinationPath = command.workspaceRoot;
  const fail = (detail: string, cause?: unknown) =>
    new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });
  return Effect.gen(function* () {
    const capture = (directory: string) =>
      Effect.tryPromise({
        try: () => captureWorktreePathIdentity(directory),
        catch: (cause) =>
          fail(
            `Select an existing directory; could not verify project folder '${directory}': ${String(cause)}. No files were transferred.`,
            cause,
          ),
      });
    const source = yield* capture(sourcePath);
    const destination = yield* capture(destinationPath);
    const reservations = makeWorktreeReservations(sql);
    const operationId = `project-workspace-${crypto.randomUUID()}`;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const pending = yield* reservations.pending();
          if (
            pending.some(
              (operation) =>
                reservations.overlaps(operation, source.canonicalPath) ||
                reservations.overlaps(operation, destination.canonicalPath),
            )
          ) {
            return yield* fail(
              "Another workspace operation owns the source or destination. Resolve its status before retrying.",
            );
          }
          const threads = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
        FROM projection_threads WHERE project_id = ${project.id}`;
          const leases = yield* sql<{ canonicalPath: string; device: number; inode: number }>`SELECT
        canonical_path AS "canonicalPath", device, inode FROM worktree_runtime_leases`;
          if (
            leases.some((lease) =>
              [source, destination].some(
                (identity) =>
                  recordedWorktreePathsOverlap(lease.canonicalPath, identity.canonicalPath) ||
                  (lease.device === identity.device && lease.inode === identity.inode),
              ),
            )
          ) {
            return yield* fail(
              "Stop terminals and workspace runtimes in the source and destination before changing folders.",
            );
          }
          for (const thread of threads) {
            const active =
              yield* sql`SELECT 1 FROM thread_activity_leases WHERE thread_id = ${thread.threadId}
          UNION ALL SELECT 1 FROM worktree_runtime_leases WHERE thread_id = ${thread.threadId} LIMIT 1`;
            if (active.length)
              return yield* fail(
                `Stop execution and close terminals in thread '${thread.threadId}' before changing its project folder.`,
              );
          }
          yield* sql`INSERT INTO worktree_operations
        (operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
         canonical_path, device, inode, branch, phase, created_at)
        VALUES (${operationId}, ${command.commandId}, 'access', ${source.canonicalPath}, ${sourcePath},
          ${source.canonicalPath}, ${destination.canonicalPath}, ${source.canonicalPath}, ${source.device},
          ${source.inode}, 'workspace-mutation', 'dispatched', ${new Date().toISOString()})`;
          for (const thread of threads)
            yield* sql`INSERT INTO worktree_operation_items
        (operation_id, thread_id, old_path, new_path, command_id)
        VALUES (${operationId}, ${thread.threadId}, ${sourcePath}, ${destinationPath}, ${`${operationId}:${thread.threadId}`})`;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrchestrationCommandInvariantError)(cause)
            ? cause
            : fail("Could not acquire project folder admission. No files were transferred.", cause),
        ),
      );
    // Interruption is not proof the filesystem promise exited: it deliberately retains admission.
    const result = yield* run.pipe(Effect.result);
    const observed = yield* sql<{
      workspaceRoot: string;
    }>`SELECT workspace_root AS "workspaceRoot" FROM projection_projects WHERE project_id = ${project.id}`.pipe(
      Effect.result,
    );
    if (
      observed._tag === "Failure" ||
      observed.success.length !== 1 ||
      ![sourcePath, destinationPath].includes(observed.success[0]!.workspaceRoot)
    ) {
      yield* sql`UPDATE worktree_operations SET phase = 'recovery-required', error = 'Project folder commit could not be confirmed'
        WHERE operation_id = ${operationId}`.pipe(Effect.result);
      return yield* fail(
        `Could not confirm project folder commit for operation '${operationId}'. The workspace remains fenced; inspect the command outcome before recovery. Neither folder was deleted or cleared.`,
      );
    }
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM worktree_operation_items WHERE operation_id = ${operationId}`;
          yield* sql`DELETE FROM worktree_operations WHERE operation_id = ${operationId} AND kind = 'access'`;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          fail(
            `Project folder operation '${operationId}' remains fenced because admission release could not be confirmed. Inspect its command outcome before recovery.`,
            cause,
          ),
        ),
      );
    if (result._tag === "Failure") return yield* Effect.fail(result.failure);
    return result.success;
  });
}
