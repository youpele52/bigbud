import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive,
    ProjectionThreadRepositoryLive,
    ThreadRetentionRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const projectId = ProjectId.makeUnsafe("retention-subtree-project");
const rootThreadId = ThreadId.makeUnsafe("retention-subtree-root");
const childThreadId = ThreadId.makeUnsafe("retention-subtree-child");
const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const now = "2026-03-01T00:00:00.000Z";

layer("ThreadRetentionRepository subtree exclusions", (it) => {
  it.effect("protects a root when a descendant has pending work", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const threads = yield* ProjectionThreadRepository;
      const retention = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* projects.upsert({
        projectId,
        title: "Retention subtree",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        workspaceRoot: "/tmp/retention-subtree",
        defaultModelSelection: null,
        scripts: [],
        createdAt: oldAt,
        updatedAt: oldAt,
        deletingAt: null,
        deletedAt: null,
      });
      for (const [threadId, parentThread] of [
        [rootThreadId, undefined],
        [childThreadId, { threadId: rootThreadId, projectId, title: "Retention subtree root" }],
      ] as const) {
        yield* threads.upsert({
          threadId,
          projectId,
          title: threadId,
          purpose: "standard",
          elevatorSummary: threadId,
          elevatorSummaryMessageCount: 0,
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "local",
          executionTargetId: "local",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          ...(parentThread === undefined ? {} : { parentThread }),
          latestTurnId: null,
          queuedPrompts: [],
          createdAt: oldAt,
          updatedAt: oldAt,
          lastActivityAt: oldAt,
          archivedAt: null,
          pinnedAt: null,
          deletingAt: null,
          deletedAt: null,
        });
      }
      yield* sql`
        UPDATE projection_threads
        SET queued_prompts_json = '[{"id":"queued-child-message"}]'
        WHERE thread_id = ${childThreadId}
      `;

      assert.deepEqual(yield* retention.selectNextPage({ cutoffAt, limit: 10 }), []);
      assert.equal((yield* retention.preview(cutoffAt)).eligibleCount, 0);

      yield* retention.createOrGetActiveRun({
        runId: "retention-subtree-run",
        trigger: "manual",
        policy: "30-days",
        cutoffAt,
        createdAt: now,
      });
      yield* retention.transitionRun({
        runId: "retention-subtree-run",
        expectedStatuses: ["queued"],
        nextStatus: "selecting",
        updatedAt: now,
      });
      yield* retention.insertSelectedPage({
        runId: "retention-subtree-run",
        candidates: [
          {
            threadId: rootThreadId,
            lastActivityAt: oldAt,
            deletionCommandId: "delete-retention-subtree",
          },
        ],
        createdAt: now,
        expectedStatus: "selecting",
        expectedCursor: null,
        nextCursor: { threadId: rootThreadId, lastActivityAt: oldAt },
      });
      assert.deepEqual(
        yield* retention.recheckAndClaimItem({
          runId: "retention-subtree-run",
          threadId: rootThreadId,
          expectedLastActivityAt: oldAt,
          cutoffAt,
          claimedAt: now,
        }),
        { claimed: false, reason: "pending_work" },
      );
    }),
  );
});
