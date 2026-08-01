import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore command events", (it) => {
  it.effect("reads only ordered events for one indexed command id", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const commandId = CommandId.makeUnsafe("cmd-keyed-read");
      for (const [index, eventCommandId] of [
        CommandId.makeUnsafe("cmd-unrelated"),
        commandId,
        commandId,
      ].entries()) {
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe(`evt-keyed-read-${index}`),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe(`project-keyed-read-${index}`),
          occurredAt: now,
          commandId: eventCommandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe(`project-keyed-read-${index}`),
            title: `Project ${index}`,
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const events = yield* eventStore.readByCommandId!(commandId);
      assert.deepStrictEqual(
        events.map((event) => event.eventId),
        ["evt-keyed-read-1", "evt-keyed-read-2"],
      );
      const queryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT sequence FROM orchestration_events
        WHERE command_id = ${commandId}
        ORDER BY sequence ASC
      `;
      assert.ok(queryPlan.some((row) => row.detail.includes("idx_orch_events_command_id")));
    }),
  );
});
