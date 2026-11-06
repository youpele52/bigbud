import { Effect } from "effect";
import { assertIdleWorkspaceOwner } from "./ProjectWorkspace.nativeIdleAdmission.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { captureWorktreePathIdentity } from "../retention/worktreeRuntimeLease.ts";
import { recordedWorktreePathsOverlap } from "../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import { makeWorktreeReservations } from "../git/Layers/WorktreeReservations.ts";
import { assertInactiveWorktreeThread } from "../git/Layers/WorktreeReferences.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const failure = (detail: string) =>
  new OrchestrationCommandInvariantError({
    commandType: "project.reconfigure",
    detail,
  });

/** Acquire the existing runtime admission fence and native saga journal in one SQL transaction.
 * No filesystem/native mutation occurs here; only existing, explicitly selected local folders qualify.
 * The caller supplies positively observed idle owners under its engine barrier, acquires admission,
 * then closes those handles outside the barrier. Reservations survive errors/interruption.
 */
export function reserveProjectWorkspaceTransition(
  sql: SqlClient.SqlClient,
  input: {
    readonly operationId: string;
    readonly commandId: string;
    readonly projectId: string;
    readonly requestDigest: string;
    readonly requestJson: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly idleOwners?: ReadonlyArray<{ readonly threadId: string; readonly provider: string }>;
  },
) {
  return Effect.gen(function* () {
    const capture = (path: string) =>
      Effect.tryPromise({
        try: () => captureWorktreePathIdentity(path),
        catch: () =>
          failure(
            `Could not verify workspace identity at '${path}'. No files or native sessions were changed.`,
          ),
      });
    const source = yield* capture(input.sourcePath);
    const destination = yield* capture(input.destinationPath);
    if (
      recordedWorktreePathsOverlap(source.canonicalPath, destination.canonicalPath) ||
      (source.device === destination.device && source.inode === destination.inode)
    ) {
      return yield* Effect.fail(
        failure("Workspace source and destination must be distinct, non-overlapping folders."),
      );
    }
    const reservations = makeWorktreeReservations(sql);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<{
          operationId: string;
          commandId: string;
          projectId: string;
          requestDigest: string;
          requestJson: string;
          sourcePath: string;
          destinationPath: string;
          phase: string;
        }>`SELECT n.operation_id AS "operationId", n.command_id AS "commandId",
        n.project_id AS "projectId", o.request_digest AS "requestDigest",
        n.request_json AS "requestJson", n.source_path AS "sourcePath",
        n.destination_path AS "destinationPath", n.phase
        FROM project_workspace_native_operations n JOIN worktree_operations o USING(operation_id)
        WHERE n.operation_id = ${input.operationId} OR n.command_id = ${input.commandId}`;
        if (existing.length) {
          const row = existing[0]!;
          if (
            existing.length !== 1 ||
            row.operationId !== input.operationId ||
            row.commandId !== input.commandId ||
            row.projectId !== input.projectId ||
            row.requestDigest !== input.requestDigest ||
            row.requestJson !== input.requestJson ||
            row.sourcePath !== input.sourcePath ||
            row.destinationPath !== input.destinationPath
          ) {
            return yield* Effect.fail(
              failure(
                "Workspace recovery identity conflicts with the retained command. Nothing was dispatched.",
              ),
            );
          }
          // Returning a retained operation is observation only, never permission to redispatch.
          return { operationId: row.operationId, phase: row.phase, retained: true as const };
        }
        const project = yield* sql`SELECT 1 FROM projection_projects
        WHERE project_id = ${input.projectId} AND workspace_root = ${input.sourcePath}
          AND workspace_execution_target_id = 'local' AND provider_runtime_execution_target_id = 'local'
          AND deleted_at IS NULL LIMIT 1`;
        if (!project.length)
          return yield* Effect.fail(
            failure(
              "The project or its local workspace changed before reservation. Refresh before retrying.",
            ),
          );
        const active = yield* sql`SELECT 1 FROM project_workspace_native_operations
        WHERE project_id = ${input.projectId} AND phase NOT IN ('committed','rejected') LIMIT 1`;
        if (active.length)
          return yield* Effect.fail(
            failure(
              "A workspace transition already owns this project. Resolve its recovery status before retrying.",
            ),
          );
        const pending = yield* reservations.pending();
        if (
          pending.some(
            (operation) =>
              reservations.overlaps(operation, source.canonicalPath) ||
              reservations.overlaps(operation, destination.canonicalPath),
          )
        ) {
          return yield* Effect.fail(
            failure(
              "Another workspace operation owns the source or destination. Nothing was dispatched.",
            ),
          );
        }
        const threads = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
        FROM projection_threads WHERE project_id = ${input.projectId}`;
        for (const thread of threads) {
          const providers =
            input.idleOwners
              ?.filter((owner) => owner.threadId === thread.threadId)
              .map((owner) => owner.provider) ?? [];
          if (providers.length) yield* assertIdleWorkspaceOwner(sql, thread.threadId, providers);
          else yield* assertInactiveWorktreeThread(sql, thread.threadId);
        }
        const leases = yield* sql<{ canonicalPath: string; device: number; inode: number }>`
        SELECT canonical_path AS "canonicalPath", device, inode FROM worktree_runtime_leases`;
        if (
          leases.some((lease) =>
            [source, destination].some(
              (identity) =>
                recordedWorktreePathsOverlap(lease.canonicalPath, identity.canonicalPath) ||
                (lease.device === identity.device && lease.inode === identity.inode),
            ),
          )
        ) {
          return yield* Effect.fail(
            failure(
              "Stop terminals and workspace runtimes in the source and destination before changing folders.",
            ),
          );
        }
        const now = new Date().toISOString();
        yield* sql`INSERT INTO worktree_operations
        (operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
         canonical_path, device, inode, branch, phase, created_at)
        VALUES (${input.operationId}, ${input.requestDigest}, 'access', ${source.canonicalPath},
          ${input.sourcePath}, ${source.canonicalPath}, ${destination.canonicalPath},
          ${source.canonicalPath}, ${source.device}, ${source.inode}, 'workspace-mutation', 'prepared', ${now})`;
        for (const thread of threads) {
          yield* sql`INSERT INTO worktree_operation_items
          (operation_id, thread_id, old_path, new_path, command_id)
          VALUES (${input.operationId}, ${thread.threadId}, ${input.sourcePath},
            ${input.destinationPath}, ${`${input.operationId}:${thread.threadId}`})`;
        }
        yield* sql`INSERT INTO project_workspace_native_operations
        (operation_id, command_id, project_id, request_json, source_path, destination_path,
         phase, steps_json, created_at, updated_at, source_identity_json, destination_identity_json)
        VALUES (${input.operationId}, ${input.commandId}, ${input.projectId}, ${input.requestJson},
          ${input.sourcePath}, ${input.destinationPath}, 'prepared', '[]', ${now}, ${now}, ${JSON.stringify(source)}, ${JSON.stringify(destination)})`;
        return { operationId: input.operationId, phase: "prepared", retained: false as const };
      }),
    );
  });
}
