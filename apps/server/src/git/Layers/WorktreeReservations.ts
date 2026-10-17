import { Effect, Schema } from "effect";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import {
  assertInactiveWorktreeThread,
  assertCanChangeWorktreePath,
  canonicalWorktreePath,
} from "./WorktreeReferences.ts";
import { assertWorktreeDraftBinding } from "./WorktreeDraftBinding.ts";
import { assertSavedWorktreeIdentity } from "./WorktreeSavedIdentity.ts";

export interface WorktreeOperationRow {
  readonly operationId: string;
  readonly kind: "rename" | "delete" | "create" | "access";
  readonly cwd: string;
  readonly repository: string;
  readonly source: string;
  readonly destination: string;
  readonly canonical: string;
  readonly device: number;
  readonly inode: number;
  readonly parentPath: string | null;
  readonly parentDevice: number | null;
  readonly parentInode: number | null;
  readonly branch: string | null;
  readonly head: string | null;
  readonly phase: string;
  readonly requestDigest: string;
  readonly error: string | null;
}

export const operationColumns = `operation_id AS "operationId", kind, cwd, repository,
  source_path AS source, destination_path AS destination, canonical_path AS canonical,
  device, inode, parent_path AS "parentPath", parent_device AS "parentDevice", parent_inode AS "parentInode", branch, head, phase, request_digest AS "requestDigest", error`;

/** SQL is the durable fence; no singleton map or global lock is needed on restart. */
export function makeWorktreeReservations(sql: SqlClient.SqlClient) {
  const pending = () =>
    sql.unsafe<WorktreeOperationRow>(`SELECT ${operationColumns}
    FROM worktree_operations WHERE phase NOT IN ('completed','rejected')`);
  const overlaps = (operation: WorktreeOperationRow, value: string) =>
    [operation.source, operation.canonical, operation.destination].some((candidate) =>
      recordedWorktreePathsOverlap(candidate, value),
    );

  const assertAllows = (
    command: OrchestrationCommand,
    recoveryOperation?: string,
    expectedPath?: { readonly value: string | null },
    expectedIdentity?: { readonly path: string; readonly identity: string },
  ) =>
    Effect.gen(function* () {
      if (
        [
          "thread.turn.start",
          "thread.message.submit",
          "thread.queued-prompt.flush",
          "thread.shell.run",
        ].includes(command.type) &&
        "threadId" in command
      )
        yield* assertSavedWorktreeIdentity(sql, command.threadId);
      // Settlement must remain possible while new execution is fenced.
      if (
        command.type === "thread.session.stop" ||
        (command.type === "thread.session.set" && command.session.status === "stopped")
      )
        return;
      const operations = (yield* pending()).filter(
        (operation) => operation.kind !== "access" || operation.branch === "workspace-mutation",
      );
      if (
        !operations.length &&
        !("worktreePath" in command) &&
        !("workspaceRoot" in command) &&
        !expectedPath
      )
        return;
      if (expectedIdentity) {
        const actual = yield* Effect.tryPromise({
          try: () => captureWorktreePathIdentity(expectedIdentity.path),
          catch: (cause) =>
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Workspace identity is unavailable: ${String(cause)}`,
            }),
        });
        if (`${actual.device}:${actual.inode}` !== expectedIdentity.identity)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "stale_workspace: destination identity changed before selection committed.",
          });
      }
      const threadId = "threadId" in command ? command.threadId : null;
      if (command.type === "thread.create" && command.worktreeBinding) {
        const [project] = yield* sql<{
          readonly target: string;
        }>`SELECT workspace_execution_target_id AS target FROM projection_projects WHERE project_id = ${command.projectId}`;
        yield* assertWorktreeDraftBinding(
          sql,
          command.worktreeBinding,
          command.worktreePath,
          command.workspaceExecutionTargetId ??
            project?.target ??
            command.executionTargetId ??
            "local",
        );
      }
      const pathOwnerId = command.type === "thread.fork" ? command.sourceThreadId : threadId;
      if ("projectId" in command && command.type.startsWith("project.")) {
        const owned = yield* sql`SELECT 1 FROM worktree_operation_items i
          JOIN worktree_operations o ON o.operation_id = i.operation_id
          JOIN projection_threads t ON t.thread_id = i.thread_id
          WHERE t.project_id = ${command.projectId} AND o.phase NOT IN ('completed','rejected') LIMIT 1`;
        if (owned.length)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "workspace_busy: a worktree operation is updating saved chats in this project.",
          });
      }
      if (expectedPath && threadId) {
        const [row] = yield* sql<{
          readonly path: string | null;
        }>`SELECT worktree_path AS path FROM projection_threads WHERE thread_id = ${threadId}`;
        if (!row || row.path !== expectedPath.value)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "stale_workspace: chat workspace changed before selection was committed.",
          });
      }
      const current = pathOwnerId
        ? yield* sql<{
            readonly path: string | null;
            readonly target: string;
            readonly worktreePath: string | null;
          }>`
       SELECT COALESCE(t.worktree_path,p.workspace_root) AS path,
         t.worktree_path AS "worktreePath",
        t.workspace_execution_target_id AS target FROM projection_threads t
       JOIN projection_projects p ON p.project_id = t.project_id WHERE t.thread_id = ${pathOwnerId}`
        : [];
      const incoming =
        "worktreePath" in command
          ? command.worktreePath
          : "workspaceRoot" in command
            ? command.workspaceRoot
            : null;
      const paths = [
        current[0]?.target === "local" ? current[0].path : null,
        incoming &&
        (!("workspaceExecutionTargetId" in command) ||
        command.workspaceExecutionTargetId === undefined
          ? current[0]?.target !== undefined
            ? current[0].target === "local"
            : true
          : command.workspaceExecutionTargetId === "local")
          ? incoming
          : null,
      ].filter((value): value is string => typeof value === "string");
      const canonicalPaths = yield* Effect.forEach(paths, canonicalWorktreePath);
      if (
        !recoveryOperation &&
        !expectedIdentity &&
        !(command.type === "thread.create" && command.worktreeBinding) &&
        incoming &&
        !(command.type === "thread.meta.update" && incoming === current[0]?.worktreePath) &&
        (command.type === "thread.create" || command.type === "thread.meta.update")
      ) {
        const history = yield* sql<{
          readonly path: string;
        }>`SELECT source_path AS path FROM worktree_operations WHERE kind = 'rename' AND phase = 'completed'`;
        if (
          canonicalPaths.some((candidate) =>
            history.some((operation) => recordedWorktreePathsOverlap(candidate, operation.path)),
          )
        )
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "stale_workspace: this path was moved. Select a verified worktree; stale drafts cannot adopt a replacement at the old path.",
          });
      }
      for (const operation of operations) {
        const owned = pathOwnerId
          ? yield* sql`SELECT 1 FROM worktree_operation_items WHERE operation_id = ${operation.operationId} AND thread_id = ${pathOwnerId}`
          : [];
        if (!owned.length && !canonicalPaths.some((value) => overlaps(operation, value))) continue;
        if (recoveryOperation === operation.operationId && command.type === "thread.meta.update") {
          const allowed = yield* sql`SELECT 1 FROM worktree_operation_items
          WHERE operation_id = ${recoveryOperation} AND thread_id = ${command.threadId}
            AND command_id = ${command.commandId} AND new_path = ${command.worktreePath ?? null}`;
          if (
            allowed.length &&
            Object.keys(command).every((key) =>
              ["type", "commandId", "threadId", "worktreePath"].includes(key),
            )
          )
            continue;
        }
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "workspace_busy: a durable worktree operation owns this workspace. Nothing was dispatched.",
        });
      }
      if (
        command.type === "thread.meta.update" &&
        command.worktreePath !== undefined &&
        current[0]?.path !== command.worktreePath
      ) {
        yield* assertInactiveWorktreeThread(sql, command.threadId);
        if (!recoveryOperation) yield* assertCanChangeWorktreePath(sql, command.threadId, false);
      }
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(OrchestrationCommandInvariantError)(cause)
          ? cause
          : new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Workspace admission failed: ${String(cause)}`,
            }),
      ),
    );
  return { pending, overlaps, assertAllows };
}
