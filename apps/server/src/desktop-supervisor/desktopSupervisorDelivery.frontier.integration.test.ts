import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeEntityPurgeSql } from "../deletion/Layers/EntityPurge.sql.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";

const layer = it.layer(
  Layer.fresh(OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
);

layer("canonical purge sequence-frontier recovery", (it) => {
  it.effect("recovers once at a tail gap, rejects the future, and delivers the next append", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const runPromise = Effect.runPromiseWith(yield* Effect.services<never>());
      const now = "2026-08-30T00:00:00.000Z";
      const projectId = ProjectId.makeUnsafe("project-frontier-integration");
      const threadId = ThreadId.makeUnsafe("thread-frontier-integration");
      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("event-frontier-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("command-frontier-project"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Frontier integration",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("event-frontier-thread"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("command-frontier-thread"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          projectId,
          title: "Frontier thread",
          modelSelection: { provider: "codex", model: "gpt-5.6" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append({
        type: "thread.deleted",
        eventId: EventId.makeUnsafe("event-frontier-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("command-frontier-thread-deleted"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, threadIds: [threadId], deletedAt: now },
      });
      yield* sql`
        UPDATE orchestration_deletion_markers SET covered_by_baseline_sequence = 3
        WHERE entity_kind = 'thread' AND entity_id = ${threadId}
      `;
      yield* sql`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash, verification_status,
          verification_detail, created_at, verified_at
        ) VALUES (3, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
      `;
      yield* makeEntityPurgeSql(sql).deleteProvenThreadCanonical({ threadId });

      const replayInputs: number[] = [];
      const coordinator = new DesktopSupervisorDeliveryCoordinator({
        mode: "direct-unmanaged",
        reasonCode: "standalone",
      });
      const subscription = yield* Effect.promise(() =>
        coordinator.open({
          consumerId: "frontier-integration",
          appliedSequence: 0,
          readReplay: (fromSequenceExclusive, limit) => {
            replayInputs.push(fromSequenceExclusive);
            return runPromise(eventStore.readReplay(fromSequenceExclusive, limit));
          },
        }),
      );
      const recovery = yield* Effect.promise(async () => {
        for (;;) {
          const item = await subscription.take();
          if (!item) throw new Error("subscription closed before recovery");
          if (item.type === "recovery") return item;
        }
      });
      assert.equal(recovery.targetSequence, 3);

      const future = yield* Effect.promise(() =>
        coordinator.acknowledgeBaseline({
          recoveryId: recovery.recoveryId,
          consumerId: recovery.consumerId,
          consumerGeneration: recovery.consumerGeneration,
          serverEpoch: recovery.serverEpoch,
          appliedProjectionSequence: 4,
          applicationDurationMs: 1,
        }),
      );
      assert.deepEqual(future, { accepted: false, fenced: false, acknowledgedSequence: 0 });

      const accepted = yield* Effect.promise(() =>
        coordinator.acknowledgeBaseline({
          recoveryId: recovery.recoveryId,
          consumerId: recovery.consumerId,
          consumerGeneration: recovery.consumerGeneration,
          serverEpoch: recovery.serverEpoch,
          appliedProjectionSequence: 3,
          applicationDurationMs: 1,
        }),
      );
      assert.deepEqual(accepted, { accepted: true, fenced: false, acknowledgedSequence: 3 });

      const appended = yield* eventStore.append({
        type: "project.deleted",
        eventId: EventId.makeUnsafe("event-frontier-next"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("command-frontier-next"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { projectId, deletedAt: now },
      });
      assert.equal(appended.sequence, 4);
      yield* Effect.promise(() => subscription.offer(appended));
      const batch = yield* Effect.promise(async () => {
        for (;;) {
          const item = await subscription.take();
          if (!item) throw new Error("subscription closed before append delivery");
          if (item.type === "batch") return item;
          if (item.type === "recovery") throw new Error("unexpected second recovery");
        }
      });
      assert.deepEqual(
        batch.events.map((event) => event.sequence),
        [4],
      );
      assert.deepEqual(replayInputs, [0, 4, 3, 3]);
      subscription.close();
      yield* Effect.promise(() => coordinator.close());
    }),
  );
});
