import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  WorktreeContext,
  WorktreeOperationRecovery,
  WorktreeOperationSummary,
} from "@bigbud/contracts/workspace/worktrees.ts";
import type { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import { makeWorktreeInventory, worktreeFailure } from "./WorktreeInventory.ts";
import { operationColumns, type WorktreeOperationRow } from "./WorktreeReservations.ts";
import { recordedWorktreePathsOverlap } from "../../deletion/Layers/ThreadDeletion.worktreePaths.ts";

function summarize(
  operation: WorktreeOperationRow,
  ownsRepository = true,
): WorktreeOperationSummary {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    source: operation.source,
    destination: operation.destination,
    phase: operation.phase as WorktreeOperationSummary["phase"],
    error: operation.error,
    canRecheck:
      ownsRepository &&
      (operation.kind === "create" || operation.kind === "delete") &&
      operation.phase === "recovery-required",
  };
}

/** Durable diagnostics and explicit reconciliation remain available after the browser loses its in-memory IDs. */
export function makeWorktreeOperations(
  sql: SqlClient.SqlClient,
  git: GitCoreShape,
  reconcile: (operation: WorktreeOperationRow) => Effect.Effect<void, GitCommandError>,
) {
  const inventory = makeWorktreeInventory(git);
  const operations = (request: WorktreeContext) =>
    Effect.gen(function* () {
      const listing = yield* inventory(request);
      if (!listing.local) return [];
      const rows = yield* sql.unsafe<WorktreeOperationRow>(
        `SELECT ${operationColumns} FROM worktree_operations
      WHERE phase NOT IN ('completed','rejected') OR operation_id IN
        (SELECT operation_id FROM worktree_operations WHERE repository = ? ORDER BY rowid DESC LIMIT 50) ORDER BY rowid DESC`,
        [listing.repository],
      );
      return rows
        .filter(
          (row) =>
            row.repository === listing.repository ||
            listing.entries.some(
              (entry) =>
                recordedWorktreePathsOverlap(entry.path, row.canonical) ||
                recordedWorktreePathsOverlap(entry.path, row.destination),
            ),
        )
        .map((row) => summarize(row, row.repository === listing.repository));
    }).pipe(Effect.mapError((cause) => worktreeFailure(request.cwd, String(cause), cause)));

  const recoverOperation = (request: WorktreeOperationRecovery) =>
    Effect.gen(function* () {
      if (request.executionTargetId && request.executionTargetId !== "local")
        return yield* worktreeFailure(
          request.cwd,
          "Remote operation recovery is not supported; nothing local was dispatched.",
        );
      const listing = yield* inventory(request);
      const [operation] = yield* sql.unsafe<WorktreeOperationRow>(
        `SELECT ${operationColumns} FROM worktree_operations WHERE operation_id = ?`,
        [request.operationId],
      );
      if (!operation || operation.repository !== listing.repository)
        return yield* worktreeFailure(
          request.cwd,
          "This operation does not belong to the selected repository.",
        );
      if (operation.kind === "access")
        return yield* worktreeFailure(
          request.cwd,
          "Workspace activity exit is unconfirmed. Its reservation cannot be discarded safely.",
        );
      if (summarize(operation).canRecheck) yield* reconcile(operation).pipe(Effect.result);
      const [current] = yield* sql.unsafe<WorktreeOperationRow>(
        `SELECT ${operationColumns} FROM worktree_operations WHERE operation_id = ?`,
        [request.operationId],
      );
      if (!current)
        return yield* worktreeFailure(request.cwd, "The durable operation is no longer available.");
      return summarize(current);
    }).pipe(Effect.mapError((cause) => worktreeFailure(request.cwd, String(cause), cause)));
  return { operations, recoverOperation };
}
