import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { PROJECT_WORKTREE_PATHS_MAX } from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQueryLive } from "../orchestration/Layers/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQuery } from "../orchestration/Services/ProjectionCatalogQuery.ts";
import { makeDetailPagingWsRpcHandlers } from "./wsRpcHandlers.detailPaging.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectId = ProjectId.makeUnsafe("worktree-project");

layer("getProjectWorktreePaths", (it) => {
  it.effect("returns the distinct worktrees of one project's non-deleted threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      const insert = (id: string, project: string, path: string | null, deletedAt: string | null) =>
        sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            worktree_path, created_at, updated_at, deleted_at
          ) VALUES (
            ${id}, ${project}, ${id}, '{"provider":"codex","model":"gpt-5-codex"}', 'full-access',
            'default', ${path}, '2026-01-01', '2026-01-01', ${deletedAt}
          )
        `;
      yield* insert("wt-a", projectId, "/srv/a", null);
      yield* insert("wt-a-again", projectId, "/srv/a", null);
      yield* insert("wt-b", projectId, "/srv/b", null);
      yield* insert("wt-none", projectId, null, null);
      yield* insert("wt-deleted", projectId, "/srv/deleted", "2026-01-02");
      yield* insert("wt-other", "other-project", "/srv/other", null);

      const result = yield* query.getProjectWorktreePaths({ projectId });
      assert.deepEqual(result, {
        projectId,
        worktreePaths: ["/srv/a", "/srv/b"],
        truncated: false,
      });
    }),
  );

  it.effect(`caps the read at ${PROJECT_WORKTREE_PATHS_MAX} paths and reports truncation`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      const many = ProjectId.makeUnsafe("many-worktrees");
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0 UNION ALL SELECT value + 1 FROM sequence
          WHERE value < ${PROJECT_WORKTREE_PATHS_MAX + 9}
        )
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          worktree_path, created_at, updated_at
        )
        SELECT printf('many-%04d', value), ${many}, 'Thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          printf('/srv/many/%04d', value), '2026-01-01', '2026-01-01'
        FROM sequence
      `;

      const result = yield* query.getProjectWorktreePaths({ projectId: many });
      assert.equal(result.worktreePaths.length, PROJECT_WORKTREE_PATHS_MAX);
      assert.isTrue(result.truncated);
    }),
  );
});

it.effect("routes the bounded detail paging RPCs and maps a missing message to an error", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-rpc");
    const context = {
      projectionCatalogQuery: {
        getProjectWorktreePaths: (input: { readonly projectId: ProjectId }) =>
          Effect.succeed({
            projectId: input.projectId,
            worktreePaths: ["/srv/a"],
            truncated: false,
          }),
        getMessageTextChunk: () => Effect.succeed(Option.none()),
        getTurnActivities: () => Effect.die(new Error("not used")),
      },
    } as unknown as WsRpcContext;
    const handlers = makeDetailPagingWsRpcHandlers(context);

    const paths = yield* handlers[ORCHESTRATION_WS_METHODS.getProjectWorktreePaths]({ projectId });
    assert.deepEqual(paths.worktreePaths, ["/srv/a"]);

    const missing = yield* Effect.exit(
      handlers[ORCHESTRATION_WS_METHODS.getMessageTextChunk]({
        threadId,
        messageId: MessageId.makeUnsafe("missing"),
        offset: 0,
      }),
    );
    assert.isTrue(Exit.isFailure(missing));
  }),
);
