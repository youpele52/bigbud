import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { WorktreeSelection } from "@bigbud/contracts/workspace/worktrees.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import { makeWorktreeInventory, worktreeFailure } from "./WorktreeInventory.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import {
  assertInactiveWorktreeThread,
  assertCanChangeWorktreePath,
  canonicalWorktreePath,
} from "./WorktreeReferences.ts";

/** Selection commits only against the exact source revision and destination filesystem identity. */
export function makeWorktreeSelection(input: {
  sql: SqlClient.SqlClient;
  git: GitCoreShape;
  engine: OrchestrationEngineShape;
}) {
  const { sql, engine } = input;
  return (request: WorktreeSelection) =>
    Effect.gen(function* () {
      if (!isLocalExecutionTarget(request.executionTargetId))
        return yield* worktreeFailure(
          request.cwd,
          "This selection endpoint is local-first. No host filesystem lookup or local fallback was attempted.",
        );
      const listing = yield* makeWorktreeInventory(input.git)(request);
      const canonical = yield* canonicalWorktreePath(request.path);
      const entry = listing.entries.find((candidate) => candidate.path === canonical);
      if (
        !listing.local ||
        !entry?.identity ||
        entry.identity !== request.expectedIdentity ||
        entry.bare ||
        entry.prunable ||
        entry.locked
      )
        return yield* worktreeFailure(
          request.cwd,
          "Workspace is unavailable or changed. Refresh and select again.",
        );
      const [thread] = yield* sql<{
        readonly path: string | null;
        readonly root: string | null;
        readonly target: string;
      }>`
      SELECT t.worktree_path AS path, p.workspace_root AS root, t.workspace_execution_target_id AS target
      FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id WHERE t.thread_id = ${request.threadId}`;
      if (
        !thread ||
        !thread.root ||
        thread.target !== "local" ||
        thread.path !== request.expectedPath
      )
        return yield* worktreeFailure(
          request.cwd,
          "Chat workspace changed; refresh before switching.",
        );
      const project = yield* makeWorktreeInventory(input.git)({ cwd: thread.root });
      if (project.repository !== listing.repository)
        return yield* worktreeFailure(
          request.cwd,
          "Selected worktree belongs to another repository.",
        );
      const root = yield* canonicalWorktreePath(thread.root);
      const nextPath = root === entry.path ? null : entry.path;
      yield* assertInactiveWorktreeThread(sql, request.threadId);
      if (thread.path !== nextPath) yield* assertCanChangeWorktreePath(sql, request.threadId);
      yield* engine.dispatch(
        {
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(request.commandId),
          threadId: request.threadId,
          worktreePath: nextPath,
          branch: entry.branch,
        },
        {
          expectedWorktreePath: { value: request.expectedPath },
          expectedWorktreeIdentity: { path: entry.path, identity: entry.identity },
        },
      );
    }).pipe(Effect.mapError((cause) => worktreeFailure(request.cwd, String(cause), cause)));
}
