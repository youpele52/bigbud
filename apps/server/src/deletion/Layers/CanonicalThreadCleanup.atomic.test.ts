import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DirectResourceCleanupRepository } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import { DirectResourceCleanupRepositoryLive } from "../../persistence/Layers/DirectResourceCleanupRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { finalizeThreadCanonicalHistory } from "./CanonicalThreadCleanup.ts";
import { recoverCanonicalPruningCandidates } from "./DirectResourceCleanupRecovery.ts";

const layer = it.layer(
  DirectResourceCleanupRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectionPipeline = {
  ensureVerifiedBaselineThroughWithoutCompaction: () => Effect.void,
} as never;

const prepareCanonicalRows = Effect.fn("prepareCanonicalRows")(function* (suffix: string) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* DirectResourceCleanupRepository;
  const threadId = ThreadId.makeUnsafe(`canonical-atomic-${suffix}`);
  const now = "2026-08-30T00:00:00.000Z";
  const operationId = `operation-${suffix}`;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, actor_kind, payload_json, metadata_json
    ) VALUES (${`event-${suffix}`}, 'thread', ${threadId}, 1, 'thread.deleted', ${now},
      ${`command-${suffix}`}, 'server', '{}', '{}')
  `;
  const [event] = yield* sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events WHERE event_id = ${`event-${suffix}`}
  `;
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status,
      created_at, verified_at
    ) VALUES (${event!.sequence}, 1, '{}', ${`hash-${suffix}`}, 'verified', ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES ('thread', ${threadId}, ${event!.sequence}, ${now}, ${event!.sequence})
  `;
  yield* sql`
    INSERT INTO direct_resource_cleanup_intents (
      intent_id, event_id, source_command_id, source_payload_digest_version,
      source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
    ) VALUES (${`intent-${suffix}`}, ${`intent-event-${suffix}`}, ${`source-${suffix}`},
      'v1', 'source', 'thread', ${threadId}, 'single', ${now})
  `;
  yield* repository.prepare({
    operationId,
    intentId: `intent-${suffix}`,
    finalizeCommandId: `finalize-${suffix}`,
    finalizePayloadJson: "{}",
    finalizePayloadDigestVersion: "v1",
    finalizePayloadDigest: "digest",
    planDigest: "plan",
    expectedPlatform: "darwin/arm64",
    resources: [],
    createdAt: now,
  });
  yield* sql`
    INSERT INTO direct_resource_cleanup_proofs (
      operation_id, receipt_status, aggregate_kind, aggregate_id,
      payload_digest_version, payload_digest, event_id, event_sequence, event_type,
      event_payload_json, proof_digest, proven_at
    ) VALUES (${operationId}, 'accepted', 'thread', ${threadId}, 'v1', 'digest',
      ${`proof-event-${suffix}`}, ${event!.sequence}, 'thread.deleted', '{}',
      '0000000000000000000000000000000000000000000000000000000000000000', ${now})
  `;
  return { sql, repository, threadId, operationId, deletionSequence: event!.sequence, now };
});

layer("atomic canonical pruning checkpoint", (it) => {
  it.effect("rolls canonical deletion back when the marker update fails", () =>
    Effect.gen(function* () {
      const fixture = yield* prepareCanonicalRows("marker-failure");
      yield* fixture.sql`
        CREATE TRIGGER fail_canonical_checkpoint BEFORE UPDATE OF canonical_pruned_at
        ON direct_resource_cleanup_proofs BEGIN SELECT RAISE(ABORT, 'marker failed'); END
      `;
      const exit = yield* Effect.exit(
        finalizeThreadCanonicalHistory({
          projectionPipeline,
          sql: fixture.sql,
          threadId: fixture.threadId,
          deletionSequence: fixture.deletionSequence,
          recordCheckpoint: fixture.repository.markCanonicalPruned(
            fixture.operationId,
            fixture.now,
          ),
        }),
      );
      assert.equal(exit._tag, "Failure");
      assert.equal((yield* fixture.sql`SELECT 1 FROM orchestration_events`).length, 1);
      assert.equal((yield* fixture.sql`SELECT 1 FROM orchestration_deletion_markers`).length, 1);
      yield* fixture.sql`DROP TRIGGER fail_canonical_checkpoint`;
    }),
  );

  it.effect("rolls the marker back when canonical deletion fails", () =>
    Effect.gen(function* () {
      const fixture = yield* prepareCanonicalRows("deletion-failure");
      yield* fixture.sql`
        CREATE TRIGGER fail_canonical_delete BEFORE DELETE ON orchestration_events
        BEGIN SELECT RAISE(ABORT, 'delete failed'); END
      `;
      const exit = yield* Effect.exit(
        finalizeThreadCanonicalHistory({
          projectionPipeline,
          sql: fixture.sql,
          threadId: fixture.threadId,
          deletionSequence: fixture.deletionSequence,
          recordCheckpoint: fixture.repository.markCanonicalPruned(
            fixture.operationId,
            fixture.now,
          ),
        }),
      );
      assert.equal(exit._tag, "Failure");
      const [proof] = yield* fixture.sql<{ readonly prunedAt: string | null }>`
        SELECT canonical_pruned_at AS "prunedAt" FROM direct_resource_cleanup_proofs
      `;
      assert.equal(proof!.prunedAt, null);
      yield* fixture.sql`DROP TRIGGER fail_canonical_delete`;
    }),
  );

  it.effect("commits canonical deletion and its marker together", () =>
    Effect.gen(function* () {
      const fixture = yield* prepareCanonicalRows("success");
      yield* finalizeThreadCanonicalHistory({
        projectionPipeline,
        sql: fixture.sql,
        threadId: fixture.threadId,
        deletionSequence: fixture.deletionSequence,
        recordCheckpoint: fixture.repository.markCanonicalPruned(fixture.operationId, fixture.now),
      });
      assert.equal(
        (yield* fixture.sql`
          SELECT 1 FROM orchestration_events WHERE event_id = 'event-success'
        `).length,
        0,
      );
      const [proof] = yield* fixture.sql<{ readonly prunedAt: string | null }>`
        SELECT canonical_pruned_at AS "prunedAt" FROM direct_resource_cleanup_proofs
        WHERE operation_id = 'operation-success'
      `;
      assert.equal(proof!.prunedAt, fixture.now);
    }),
  );

  it.effect("isolates a failed pruning candidate from later candidates", () =>
    Effect.gen(function* () {
      const completed: string[] = [];
      yield* recoverCanonicalPruningCandidates({
        candidates: ["failed", "completed"],
        finalizeCandidate: (candidate) =>
          candidate === "failed"
            ? Effect.fail(new Error("failed candidate"))
            : Effect.sync(() => void completed.push(candidate)),
      });
      assert.deepEqual(completed, ["completed"]);
    }),
  );
});
