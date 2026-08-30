import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { ProjectionBaselineRepository } from "../Services/ProjectionBaselines.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { ProjectionBaselineRepositoryLive } from "./ProjectionBaselines.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const eventStoreLayer = OrchestrationEventStoreLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

function projectCreated(index: number, now: string) {
  const projectId = ProjectId.makeUnsafe(`project-frontier-${index}`);
  return {
    type: "project.created" as const,
    eventId: EventId.makeUnsafe(`event-frontier-${index}`),
    aggregateKind: "project" as const,
    aggregateId: projectId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe(`command-frontier-${index}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId,
      title: `Frontier ${index}`,
      workspaceRoot: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

it.layer(Layer.fresh(eventStoreLayer))("orchestration sequence frontier", (it) => {
  it.effect("includes trailing gaps in replay and reserves the first append after the tail", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-30T00:00:00.000Z";
      for (const index of [1, 2, 3]) yield* eventStore.append(projectCreated(index, now));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
            SELECT sequence, event_id, ${now} FROM orchestration_events WHERE sequence >= 2
          `;
          yield* sql`DELETE FROM orchestration_event_ids WHERE sequence >= 2`;
          yield* sql`DELETE FROM orchestration_events WHERE sequence >= 2`;
        }),
      );

      const unavailable = yield* eventStore.readReplay(0);
      assert.equal(unavailable.latestSequence, 3);
      assert.equal(unavailable.retainedFromSequenceExclusive, 3);
      assert.equal(unavailable.availability, "gap");

      const recovered = yield* eventStore.readReplay(3);
      assert.equal(recovered.latestSequence, 3);
      assert.equal(recovered.availability, "available");
      assert.equal(recovered.complete, true);

      const appended = yield* eventStore.append(projectCreated(4, now));
      assert.equal(appended.sequence, 4);
      assert.deepEqual(
        yield* sql`
          SELECT event.sequence AS "eventSequence", ledger.sequence AS "ledgerSequence"
          FROM orchestration_events AS event
          JOIN orchestration_event_ids AS ledger ON ledger.event_id = event.event_id
          WHERE event.event_id = ${appended.eventId}
        `,
        [{ eventSequence: 4, ledgerSequence: 4 }],
      );
      assert.deepEqual(
        yield* sql`SELECT sequence FROM orchestration_event_gaps ORDER BY sequence`,
        [{ sequence: 2 }, { sequence: 3 }],
      );
    }),
  );
});

it.layer(
  Layer.fresh(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
)("projection baseline sequence frontier", (it) => {
  it.effect("accepts a candidate whose projector sequence is represented by a tail gap", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-30T00:00:00.000Z";
      yield* sql`
        INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
        VALUES (1, 'event-baseline-tail-gap', ${now})
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('frontier-projector', 1, ${now})
      `;

      const candidate = yield* baselines.createCandidate(["frontier-projector"]);

      assert.equal(candidate._tag, "Some");
      if (candidate._tag === "Some") assert.equal(candidate.value.sequence, 1);
    }),
  );
});
