import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore identity", (it) => {
  it.effect("appends thread.created before any projection thread row exists", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-created-before-projection");
      const projectId = ProjectId.makeUnsafe("project-created-before-projection");

      const appended = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-created-before-projection"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-created-before-projection"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Created before projection",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      assert.equal(appended.type, "thread.created");
      assert.deepEqual(
        yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM orchestration_thread_identity
          WHERE thread_id = ${threadId}
        `,
        [{ threadId }],
      );
      assert.deepEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id = ${threadId}
        `,
        [{ count: 0 }],
      );
    }),
  );

  it.effect("resolves compacted thread ownership from its durable identity", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-identity-marker");
      const projectId = ProjectId.makeUnsafe("project-identity-marker");
      yield* sql`
        INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
        VALUES (${threadId}, ${projectId}, 1)
      `;
      assert.deepEqual(yield* eventStore.findThreadProjectId(threadId), Option.some(projectId));
      assert.deepEqual(
        yield* eventStore.findThreadOwnershipEvidence(threadId),
        Option.some({
          projectId,
          latestCreatedSequence: 1,
          deletionSequence: null,
          deletedAt: null,
        }),
      );
    }),
  );

  it.effect("orders deletion evidence after the latest create", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-deletion-marker");
      const projectId = ProjectId.makeUnsafe("project-deletion-marker");
      yield* sql`
        INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
        VALUES (${threadId}, ${projectId}, 10)
      `;
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
        ) VALUES ('thread', ${threadId}, 12, '2026-08-26T10:02:35.000Z', NULL)
      `;

      assert.deepEqual(
        yield* eventStore.findThreadOwnershipEvidence(threadId),
        Option.some({
          projectId,
          latestCreatedSequence: 10,
          deletionSequence: 12,
          deletedAt: "2026-08-26T10:02:35.000Z",
        }),
      );
    }),
  );

  it.effect("orders an older deletion marker behind the latest recreated identity", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("thread-recreated-after-deletion");
      const projectId = ProjectId.makeUnsafe("project-recreated-after-deletion");
      yield* sql`
        INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
        VALUES (${threadId}, ${projectId}, 13)
      `;
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
        ) VALUES ('thread', ${threadId}, 12, '2026-08-26T10:02:35.000Z', NULL)
      `;

      assert.deepEqual(
        yield* eventStore.findThreadOwnershipEvidence(threadId),
        Option.some({
          projectId,
          latestCreatedSequence: 13,
          deletionSequence: 12,
          deletedAt: "2026-08-26T10:02:35.000Z",
        }),
      );
    }),
  );

  it.effect("returns marker-only canonical evidence when a legacy identity is missing", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("legacy-marker-without-identity");
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
        ) VALUES ('thread', ${threadId}, 19, '2026-08-26T10:02:35.000Z', NULL)
      `;

      assert.deepEqual(
        yield* eventStore.findThreadOwnershipEvidence(threadId),
        Option.some({
          projectId: null,
          latestCreatedSequence: null,
          deletionSequence: 19,
          deletedAt: "2026-08-26T10:02:35.000Z",
        }),
      );
    }),
  );
});
