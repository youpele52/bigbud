import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import type { SearchProjectRoot, SearchWorktreeRoot } from "./SystemSearch.roots.ts";

/** Upper bounds keep one query cheap; the agent accepts at most 128 roots per request anyway. */
const MAX_PROJECT_ROOTS = 500;
const MAX_WORKTREE_ROOTS = 500;

const ProjectRootRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  executionTargetId: Schema.String,
  root: Schema.String,
});

const WorktreeRootRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  executionTargetId: Schema.String,
  root: Schema.String,
});

/**
 * Reads the folders `search.query` may walk: live projects with a folder (most recently used
 * first) and live threads' worktrees. Only ids, titles, targets and folders are read.
 */
export const makeSearchRootsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readProjects = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectRootRow,
    execute: () => sql`
      SELECT
        project_id AS "projectId",
        title,
        workspace_execution_target_id AS "executionTargetId",
        workspace_root AS "root"
      FROM projection_projects
      WHERE deleted_at IS NULL AND deleting_at IS NULL AND workspace_root IS NOT NULL
        AND workspace_root != ''
      ORDER BY updated_at DESC, project_id ASC
      LIMIT ${MAX_PROJECT_ROOTS}
    `,
  });
  const readWorktrees = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorktreeRootRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        workspace_execution_target_id AS "executionTargetId",
        worktree_path AS "root"
      FROM projection_threads
      WHERE deleted_at IS NULL AND deleting_at IS NULL AND worktree_path IS NOT NULL
        AND worktree_path != ''
      ORDER BY updated_at DESC, thread_id ASC
      LIMIT ${MAX_WORKTREE_ROOTS}
    `,
  });
  return {
    read: Effect.fn("SystemSearch.readRoots")(function* () {
      const [projects, worktrees] = yield* Effect.all([readProjects(), readWorktrees()]).pipe(
        Effect.mapError(toPersistenceSqlError("SystemSearch.readRoots")),
      );
      return {
        projects: projects as ReadonlyArray<SearchProjectRoot>,
        worktrees: worktrees as ReadonlyArray<SearchWorktreeRoot>,
      };
    }),
  };
});
