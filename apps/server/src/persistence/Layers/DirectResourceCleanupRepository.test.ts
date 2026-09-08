import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DirectResourceCleanupRepository } from "../Services/DirectResourceCleanupRepository.ts";
import { DirectResourceCleanupRepositoryLive } from "./DirectResourceCleanupRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  DirectResourceCleanupRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("DirectResourceCleanupRepository", (it) => {
  it.effect("keeps plans immutable and claims only proven work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* DirectResourceCleanupRepository;
      const now = "2026-08-29T00:00:00.000Z";
      yield* sql`
        INSERT INTO direct_resource_cleanup_intents (
          intent_id, event_id, source_command_id, source_payload_digest_version,
          source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
        ) VALUES ('intent', 'event', 'source', 'v1', 'source',
          'thread', 'thread', 'subtree', ${now})
      `;
      const input = {
        operationId: "operation",
        intentId: "intent",
        finalizeCommandId: "finalize",
        finalizePayloadJson: JSON.stringify({
          type: "thread.delete.finalize",
          threadId: "thread",
          threadIds: ["thread"],
          createdAt: now,
        }),
        finalizePayloadDigestVersion: "v1",
        finalizePayloadDigest: "payload",
        planDigest: "plan",
        expectedPlatform: "darwin/arm64",
        resources: [
          {
            resourceId: "resource",
            kind: "attachment" as const,
            root: "/managed",
            relativePath: "resource",
            quarantineName: ".bigbud-cleanup-resource",
            identity: { entryType: "file" as const, deviceOrVolume: "1", inodeOrFileId: "2" },
            rootIdentity: {
              entryType: "directory" as const,
              deviceOrVolume: "1",
              inodeOrFileId: "1",
            },
            parentIdentity: {
              entryType: "directory" as const,
              deviceOrVolume: "1",
              inodeOrFileId: "1",
            },
          },
        ],
        createdAt: now,
      };
      yield* repository.prepare(input);
      yield* repository.prepare(input);
      const conflictingPrepare = yield* Effect.exit(
        repository.prepare({ ...input, planDigest: "changed" }),
      );
      assert.equal(conflictingPrepare._tag, "Failure");
      assert.equal(
        yield* repository.claimReady({
          leaseId: "early",
          claimedAt: now,
          expiresAt: "2026-08-29T00:01:00.000Z",
          expectedPlatform: "darwin/arm64",
        }),
        undefined,
      );
      const deletedPayload = JSON.stringify({
        threadId: "thread",
        threadIds: ["thread"],
        deletedAt: now,
      });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
          payload_digest_version, payload_digest
        ) VALUES ('finalize', 'thread', 'thread', ${now}, 1, 'accepted', 'v1', 'payload')
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'deleted-event', 'thread', 'thread', 1, 'thread.deleted', ${now},
          'finalize', 'server', ${deletedPayload}, '{}'
        )
      `;
      const [deletedEvent] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM orchestration_events WHERE event_id = 'deleted-event'
      `;
      yield* repository.markFinalizeCommitted({
        operationId: "operation",
        aggregateKind: "thread",
        aggregateId: "thread",
        payloadDigestVersion: "v1",
        payloadDigest: "payload",
        eventId: "deleted-event",
        eventSequence: deletedEvent!.sequence,
        eventType: "thread.deleted",
        eventPayloadJson: deletedPayload,
        provenAt: now,
      });
      assert.equal(
        yield* repository.claimReady({
          leaseId: "before-pruning",
          claimedAt: now,
          expiresAt: "2026-08-29T00:01:00.000Z",
          expectedPlatform: "darwin/arm64",
        }),
        undefined,
      );
      yield* repository.markCanonicalPruned("operation", now);
      const claimed = yield* repository.claimReady({
        leaseId: "lease",
        claimedAt: now,
        expiresAt: "2026-08-29T00:01:00.000Z",
        expectedPlatform: "darwin/arm64",
      });
      assert.equal(claimed?.operationId, "operation");
      assert.equal(
        yield* repository.renewLease({
          operationId: "operation",
          leaseId: "stale",
          renewedAt: now,
          expiresAt: "2026-08-29T00:02:00.000Z",
        }),
        false,
      );
      yield* repository.prepareAttempt({
        attemptId: "operation:page:0:attempt:0:digest",
        operationId: "operation",
        pageOrdinal: 0,
        pageDigest: "digest",
        resourceIds: ["resource"],
        requestJson: "{}",
        requestFrameHex: "0000000100",
        deadlineUnixMs: 1,
        leaseId: "lease",
        at: now,
      });
      yield* repository.markAttempt("operation:page:0:attempt:0:digest", "sent", now, "lease");
      assert.deepEqual(yield* repository.loadAmbiguousAttempt("operation", 0), {
        attemptId: "operation:page:0:attempt:0:digest",
        pageDigest: "digest",
        resourceIds: ["resource"],
        requestJson: "{}",
        requestFrameHex: "0000000100",
        deadlineUnixMs: 1,
      });
      assert.equal(
        (yield* Effect.exit(
          repository.prepareAttempt({
            attemptId: "operation:page:0:attempt:0:digest",
            operationId: "operation",
            pageOrdinal: 0,
            pageDigest: "changed",
            resourceIds: ["resource"],
            requestJson: "{}",
            requestFrameHex: "0000000100",
            deadlineUnixMs: 1,
            leaseId: "lease",
            at: now,
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          repository.recordResults(
            "operation",
            "stale",
            "operation:page:0:attempt:0:digest",
            [],
            now,
          ),
        ))._tag,
        "Failure",
      );
      yield* repository.recordResults(
        "operation",
        "lease",
        "operation:page:0:attempt:0:digest",
        [{ resourceId: "resource", outcome: "removed", errorCode: "" }],
        now,
      );
      yield* repository.complete("operation", now, "lease");
      yield* repository.releaseLease("operation", "lease");
    }),
  );

  it.effect("recovers proof from an exact accepted finalize receipt and event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* DirectResourceCleanupRepository;
      const now = "2026-08-29T00:00:00.000Z";
      yield* sql`
        INSERT INTO direct_resource_cleanup_intents (
          intent_id, event_id, source_command_id, source_payload_digest_version,
          source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
        ) VALUES ('recovery-intent', 'request-event', 'source-recovery', 'v1', 'source',
          'project', 'project', 'project', ${now})
      `;
      yield* repository.prepare({
        operationId: "recovery-operation",
        intentId: "recovery-intent",
        finalizeCommandId: "recovery-finalize",
        finalizePayloadJson: JSON.stringify({
          type: "project.delete.finalize",
          projectId: "project",
          createdAt: now,
        }),
        finalizePayloadDigestVersion: "sha256/v1",
        finalizePayloadDigest: "digest",
        planDigest: "plan",
        expectedPlatform: "darwin/arm64",
        resources: [],
        createdAt: now,
      });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status,
          payload_digest_version, payload_digest
        ) VALUES (
          'recovery-finalize', 'project', 'project', ${now}, 1, 'accepted',
          'sha256/v1', 'wrong-digest'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json
        ) VALUES (
          'project-deleted', 'project', 'project', 1, 'project.deleted', ${now},
          'recovery-finalize', 'server', ${JSON.stringify({ projectId: "project", deletedAt: now })}, '{}'
        )
      `;

      assert.equal(yield* repository.reconcilePrepared(now, "darwin/arm64"), 0);
      yield* sql`
        UPDATE orchestration_command_receipts SET payload_digest = 'digest'
        WHERE command_id = 'recovery-finalize'
      `;
      assert.equal(yield* repository.reconcilePrepared(now, "darwin/arm64"), 1);
      const claimed = yield* repository.claimReady({
        leaseId: "recovery-lease",
        claimedAt: now,
        expiresAt: "2026-08-29T00:01:00.000Z",
        expectedPlatform: "darwin/arm64",
      });
      assert.equal(claimed?.operationId, "recovery-operation");
    }),
  );

  it.effect("blocks a prepared plan when the finalize digest claim conflicts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* DirectResourceCleanupRepository;
      const now = "2026-08-29T00:00:00.000Z";
      yield* sql`
        INSERT INTO direct_resource_cleanup_intents (
          intent_id, event_id, source_command_id, source_payload_digest_version,
          source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
        ) VALUES ('conflict-intent', 'conflict-event', 'source-conflict', 'v1', 'source',
          'project', 'conflict', 'project', ${now})
      `;
      yield* repository.prepare({
        operationId: "conflict-operation",
        intentId: "conflict-intent",
        finalizeCommandId: "conflict-finalize",
        finalizePayloadJson: "{}",
        finalizePayloadDigestVersion: "sha256/v1",
        finalizePayloadDigest: "expected",
        planDigest: "plan",
        expectedPlatform: "darwin/arm64",
        resources: [],
        createdAt: now,
      });
      yield* sql`
        INSERT INTO orchestration_command_receipt_claims (
          command_id, payload_digest_version, payload_digest, claimed_at
        ) VALUES ('conflict-finalize', 'sha256/v1', 'different', ${now})
      `;

      assert.equal(yield* repository.reconcilePrepared(now, "darwin/arm64"), 0);
      const [plan] = yield* sql<{ readonly state: string; readonly errorCode: string }>`
        SELECT state, last_error_code AS "errorCode" FROM direct_resource_cleanup_plans
        WHERE operation_id = 'conflict-operation'
      `;
      assert.deepEqual(plan, { state: "blocked", errorCode: "finalize_digest_conflict" });
    }),
  );

  it.effect("lists only open intents whose live projection is deleting", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* DirectResourceCleanupRepository;
      const now = "2026-08-29T00:00:00.000Z";
      for (const [id, deletingAt] of [
        ["eligible", now],
        ["not-deleting", null],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleting_at
          ) VALUES (${id}, ${id}, '/tmp', '[]', ${now}, ${now}, ${deletingAt})
        `;
        yield* sql`
          INSERT INTO direct_resource_cleanup_intents (
            intent_id, event_id, source_command_id, source_payload_digest_version,
            source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
          ) VALUES (
            ${`intent-${id}`}, ${`event-${id}`}, ${`command-${id}`}, 'v1', 'digest',
            'project', ${id}, 'project', ${now}
          )
        `;
      }
      yield* sql`
        INSERT INTO direct_resource_cleanup_intents (
          intent_id, event_id, source_command_id, source_payload_digest_version,
          source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
        ) VALUES (
          'intent-stale', 'event-stale', 'command-stale', 'v1', 'digest',
          'project', 'missing-projection', 'project', ${now}
        )
      `;

      const intents = yield* repository.listRecoverableIntents({
        requestedAfter: "",
        intentAfter: "",
        limit: 100,
      });
      assert.deepEqual(intents, [
        {
          intentId: "intent-eligible",
          eventId: "event-eligible",
          commandId: "command-eligible",
          requestedAt: now,
        },
      ]);
    }),
  );
});
