import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("reports empty, contiguous, and compacted replay ranges", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM sqlite_sequence WHERE name = 'orchestration_events'`;

      assert.deepStrictEqual(yield* eventStore.readReplay(0), {
        requestedFromSequenceExclusive: 0,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: null,
        latestSequence: 0,
        availability: "available",
        complete: true,
        events: [],
      });

      const now = new Date().toISOString();
      for (const index of [1, 2, 3]) {
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe(`evt-replay-range-${index}`),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe(`project-replay-range-${index}`),
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`cmd-replay-range-${index}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe(`project-replay-range-${index}`),
            title: `Project ${index}`,
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const contiguous = yield* eventStore.readReplay(0);
      assert.equal(contiguous.availability, "available");
      assert.equal(contiguous.complete, true);
      assert.equal(contiguous.retainedFromSequenceExclusive, 0);
      assert.deepStrictEqual(
        contiguous.events.map((event) => event.sequence),
        [1, 2, 3],
      );

      yield* sql`DELETE FROM orchestration_events WHERE sequence = 1`;
      const gap = yield* eventStore.readReplay(0);
      assert.equal(gap.availability, "gap");
      assert.equal(gap.complete, false);
      assert.equal(gap.retainedFromSequenceExclusive, 1);
      assert.equal(gap.earliestAvailableSequence, 2);
      assert.equal(gap.latestSequence, 3);
      assert.deepStrictEqual(gap.events, []);
      yield* sql`DELETE FROM orchestration_events`;
    }),
  );

  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("persists bounded compaction progress and preserves stream versions", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_events`;
      yield* sql`DELETE FROM orchestration_stream_state`;
      yield* sql`DELETE FROM sqlite_sequence WHERE name = 'orchestration_events'`;
      yield* sql`
        UPDATE orchestration_retention_state
        SET retained_through_sequence = 0, compact_through_sequence = 0
        WHERE singleton_id = 1
      `;
      const now = new Date().toISOString();
      const projectId = ProjectId.makeUnsafe("project-compaction");
      for (const index of [1, 2]) {
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe(`evt-compaction-${index}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe(`cmd-compaction-${index}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: `Project ${index}`,
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      yield* sql`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash,
          verification_status, verification_detail, created_at, verified_at
        ) VALUES (2, 1, '{}', 'proof', 'verified', NULL, ${now}, ${now})
      `;
      yield* sql`
        UPDATE orchestration_retention_state SET compact_through_sequence = 2
        WHERE singleton_id = 1
      `;
      assert.equal((yield* eventStore.compactVerifiedPrefix!(1)).deletedCount, 1);
      const completed = yield* eventStore.compactVerifiedPrefix!(1);
      assert.equal(completed.complete, true);
      const replay = yield* eventStore.readReplay(0);
      assert.equal(replay.availability, "gap");
      assert.equal(replay.retainedFromSequenceExclusive, 2);
      assert.equal(replay.latestSequence, 2);
      assert.deepEqual(replay.events, []);

      yield* eventStore.append({
        type: "project.deleted",
        eventId: EventId.makeUnsafe("evt-compaction-3"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-compaction-3"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { projectId, deletedAt: now },
      });
      const versions = yield* sql<{ readonly version: number }>`
        SELECT stream_version AS version FROM orchestration_events WHERE event_id = 'evt-compaction-3'
      `;
      assert.deepEqual(versions, [{ version: 2 }]);
      const markers = yield* sql<{ readonly sequence: number }>`
        SELECT deletion_sequence AS sequence FROM orchestration_deletion_markers
        WHERE entity_kind = 'project' AND entity_id = ${projectId}
      `;
      assert.deepEqual(markers, [{ sequence: 3 }]);
      yield* sql`DELETE FROM orchestration_events WHERE event_id = 'evt-compaction-3'`;
      const duplicate = yield* Effect.exit(
        eventStore.append({
          type: "project.deleted",
          eventId: EventId.makeUnsafe("evt-compaction-3"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-compaction-duplicate"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { projectId, deletedAt: now },
        }),
      );
      assert.equal(duplicate._tag, "Failure");
      yield* sql`DELETE FROM orchestration_events`;
    }),
  );

  it.effect("replays legacy events with a provider removed from the current registry", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json
        ) VALUES (
          ${EventId.makeUnsafe("evt-store-removed-provider")}, ${"project"},
          ${ProjectId.makeUnsafe("project-removed-provider")}, ${0}, ${"project.created"},
          ${now}, ${CommandId.makeUnsafe("cmd-store-removed-provider")}, ${null}, ${null}, ${"server"},
          ${JSON.stringify({
            projectId: "project-removed-provider",
            title: "Legacy Project",
            workspaceRoot: null,
            defaultModelSelection: { provider: "removedProvider", model: "legacy-model" },
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })}, ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const legacyEvent = replayed.find((event) => event.eventId === "evt-store-removed-provider");
      assert.ok(legacyEvent);
      assert.deepStrictEqual(
        (legacyEvent.payload as { defaultModelSelection?: unknown }).defaultModelSelection,
        { provider: "removedProvider", model: "legacy-model" },
      );
    }),
  );

  it.effect("still rejects malformed legacy events that mention a removed provider", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json
        ) VALUES (
          ${EventId.makeUnsafe("evt-store-malformed-removed-provider")}, ${"project"},
          ${ProjectId.makeUnsafe("project-malformed-removed-provider")}, ${0}, ${"project.created"},
          ${now}, ${CommandId.makeUnsafe("cmd-store-malformed-removed-provider")}, ${null}, ${null}, ${"server"},
          ${JSON.stringify({
            projectId: "project-malformed-removed-provider",
            title: 42,
            workspaceRoot: null,
            defaultModelSelection: { provider: "removedProvider", model: "legacy-model" },
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })}, ${"{}"}
        )
      `;

      const exit = yield* Effect.exit(Stream.runCollect(eventStore.readFromSequence(0, 10)));
      assert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );
});
