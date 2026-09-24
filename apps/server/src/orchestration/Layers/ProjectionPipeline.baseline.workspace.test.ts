import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionBaselineRepository } from "../../persistence/Services/ProjectionBaselines.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { BaseTestLayer } from "./ProjectionPipeline.test.helpers.ts";

it.layer(BaseTestLayer)("projection baseline workspace", (it) => {
  it.effect("recreates a file-backed workspace whose current ledger misses a required table", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const workspacePath = path.join(
        config.stateDir,
        "projection-baseline-verification",
        "1.sqlite",
      );
      const corruptScope = yield* Scope.make("sequential");
      const corruptContext = yield* Layer.build(makeSqlitePersistenceLive(workspacePath)).pipe(
        Scope.provide(corruptScope),
      );
      const corruptSql = yield* Effect.service(SqlClient.SqlClient).pipe(
        Effect.provide(corruptContext),
      );
      const usageTable = yield* corruptSql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_usage_contributions'
      `;
      assert.deepEqual(usageTable, [{ name: "projection_usage_contributions" }]);
      yield* corruptSql`DROP TABLE projection_usage_contributions`;
      yield* Scope.close(corruptScope, Exit.void);

      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const now = "2026-08-03T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("workspace-recovery-project");
      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("workspace-recovery-event"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("workspace-recovery-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Recovery project",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* pipeline.bootstrap;
      yield* pipeline.ensureVerifiedBaselineThrough(1);

      const baselines = yield* ProjectionBaselineRepository;
      const verified = yield* baselines.latestVerified();
      assert.equal(verified._tag, "Some");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        assert.isFalse(yield* fs.exists(`${workspacePath}${suffix}`));
      }
    }),
  );

  it.effect("verifies a baseline after deleting a parent thread with a surviving child", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-03T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("parent-deletion-project");
      const parentId = ThreadId.makeUnsafe("parent-deletion-parent");
      const childId = ThreadId.makeUnsafe("parent-deletion-child");
      const append = (event: Parameters<typeof eventStore.append>[0]) => eventStore.append(event);

      yield* append({
        type: "project.created",
        eventId: EventId.makeUnsafe("parent-deletion-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("parent-deletion-project-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Parent deletion project",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const [threadId, title, parentThread] of [
        [parentId, "Parent", undefined],
        [childId, "Child", { threadId: parentId, title: "Parent", projectId }],
      ] as const) {
        yield* append({
          type: "thread.created",
          eventId: EventId.makeUnsafe(`${threadId}-created`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`${threadId}-command`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            projectId,
            title,
            modelSelection: { provider: "codex", model: "gpt-5.6" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            ...(parentThread === undefined ? {} : { parentThread }),
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      yield* pipeline.bootstrap;
      yield* pipeline.ensureVerifiedBaselineThrough(3);

      const deleted = yield* append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("parent-deletion-deleted"),
        aggregateKind: "thread",
        aggregateId: parentId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("parent-deletion-delete-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: parentId, threadIds: [parentId, childId], deletedAt: now },
      });
      yield* pipeline.projectEvent(deleted);
      yield* pipeline.ensureVerifiedBaselineThrough(4);

      const children = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_threads WHERE thread_id IN (${parentId}, ${childId})
      `;
      assert.deepEqual(children, []);
      const baselines = yield* ProjectionBaselineRepository;
      const verified = yield* baselines.latestVerified();
      assert.equal(verified._tag, "Some");
      if (verified._tag === "Some") assert.equal(verified.value.sequence, 4);
    }),
  );

  it.effect("rebuilds mixed remote and cross-project children after one parent deletion", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-23T00:00:00.000Z";
      const firstProject = ProjectId.makeUnsafe("retention-rebuild-first");
      const secondProject = ProjectId.makeUnsafe("retention-rebuild-second");
      const parent = ThreadId.makeUnsafe("retention-rebuild-parent");
      const remoteChild = ThreadId.makeUnsafe("retention-rebuild-remote-child");
      const otherThread = ThreadId.makeUnsafe("retention-rebuild-other-project");
      for (const projectId of [firstProject, secondProject]) {
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe(`${projectId}-created`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`${projectId}-create-command`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: String(projectId),
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      let lastCreatedSequence = 0;
      for (const [threadId, projectId, parentThread, remote] of [
        [parent, firstProject, undefined, false],
        [
          remoteChild,
          secondProject,
          { threadId: parent, title: "Parent", projectId: firstProject },
          true,
        ],
        [otherThread, secondProject, undefined, true],
      ] as const) {
        const created = yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe(`${threadId}-created`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`${threadId}-create-command`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId,
            projectId,
            title: String(threadId),
            modelSelection: { provider: "codex", model: "gpt-5.6" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            ...(remote
              ? { workspaceExecutionTargetId: "ssh:devbox", executionTargetId: "ssh:devbox" }
              : {}),
            ...(parentThread ? { parentThread } : {}),
            createdAt: now,
            updatedAt: now,
          },
        });
        lastCreatedSequence = created.sequence;
      }
      yield* pipeline.bootstrap;
      yield* pipeline.ensureVerifiedBaselineThrough(lastCreatedSequence);
      const linkedChild = yield* sql<{
        projectId: string;
        parentThreadId: string | null;
        parentThreadProjectId: string | null;
      }>`
        SELECT project_id AS "projectId", parent_thread_id AS "parentThreadId",
          parent_thread_project_id AS "parentThreadProjectId"
        FROM projection_threads WHERE thread_id = ${remoteChild}
      `;
      assert.deepEqual(linkedChild, [
        {
          projectId: secondProject,
          parentThreadId: parent,
          parentThreadProjectId: firstProject,
        },
      ]);
      const deleted = yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("retention-rebuild-parent-deleted"),
        aggregateKind: "thread",
        aggregateId: parent,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("retention-rebuild-delete-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId: parent, threadIds: [parent], deletedAt: now },
      });
      yield* pipeline.projectEvent(deleted);
      yield* pipeline.ensureVerifiedBaselineThrough(deleted.sequence);
      const rows = yield* sql<{
        threadId: string;
        projectId: string;
        parentThreadId: string | null;
        parentThreadProjectId: string | null;
        workspaceExecutionTargetId: string;
      }>`
        SELECT thread_id AS "threadId", project_id AS "projectId",
          parent_thread_id AS "parentThreadId",
          parent_thread_project_id AS "parentThreadProjectId",
          workspace_execution_target_id AS "workspaceExecutionTargetId"
        FROM projection_threads ORDER BY thread_id
      `;
      assert.deepEqual(
        rows.map((row) => row.threadId),
        [otherThread, remoteChild].toSorted(),
      );
      assert.equal(rows.find((row) => row.threadId === remoteChild)?.parentThreadId, null);
      assert.equal(rows.find((row) => row.threadId === remoteChild)?.parentThreadProjectId, null);
      assert.equal(rows.find((row) => row.threadId === remoteChild)?.projectId, secondProject);
      assert.equal(
        rows.find((row) => row.threadId === remoteChild)?.workspaceExecutionTargetId,
        "ssh:devbox",
      );
      assert.equal(rows.find((row) => row.threadId === otherThread)?.projectId, secondProject);
      const verified = yield* (yield* ProjectionBaselineRepository).latestVerified();
      assert.equal(verified._tag, "Some");
      if (verified._tag === "Some") assert.equal(verified.value.sequence, deleted.sequence);
    }),
  );
});
