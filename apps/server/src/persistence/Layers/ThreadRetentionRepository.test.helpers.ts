import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

export const repositories = Layer.mergeAll(
  ProjectionProjectRepositoryLive,
  ProjectionThreadRepositoryLive,
  ThreadRetentionRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
export const layer = it.layer(repositories);
export const projectId = ProjectId.makeUnsafe("retention-project");
export const oldAt = "2026-01-01T00:00:00.000Z";
export const cutoffAt = "2026-02-01T00:00:00.000Z";
export const now = "2026-03-01T00:00:00.000Z";

export const resetData = Effect.fn("resetRetentionTestData")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_retention_run_items`;
  yield* sql`DELETE FROM thread_retention_runs`;
  yield* sql`DELETE FROM thread_retention_consent_challenges`;
  yield* sql`DELETE FROM projection_thread_tasks`;
  yield* sql`DELETE FROM projection_thread_sessions`;
  yield* sql`DELETE FROM projection_thread_watches`;
  yield* sql`DELETE FROM projection_pending_approvals`;
  yield* sql`DELETE FROM thread_delegations`;
  yield* sql`DELETE FROM automation_runs`;
  yield* sql`DELETE FROM automation_schedules`;
  yield* sql`DELETE FROM purge_jobs`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
});

export const seedProject = Effect.fn("seedRetentionProject")(function* () {
  const projects = yield* ProjectionProjectRepository;
  yield* projects.upsert({
    projectId,
    title: "Retention",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    workspaceRoot: "/tmp/retention",
    defaultModelSelection: null,
    scripts: [],
    createdAt: oldAt,
    updatedAt: oldAt,
    deletingAt: null,
    deletedAt: null,
  });
});

export const seedThread = Effect.fn("seedRetentionThread")(function* (
  id: string,
  lastActivityAt = oldAt,
) {
  const threads = yield* ProjectionThreadRepository;
  yield* threads.upsert({
    threadId: ThreadId.makeUnsafe(id),
    projectId,
    title: id,
    purpose: "standard",
    elevatorSummary: id,
    elevatorSummaryMessageCount: 0,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    queuedPrompts: [],
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    lastActivityAt,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
  });
});
