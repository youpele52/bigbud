import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadId } from "@bigbud/contracts";
import {
  CANONICAL_THREAD_CLEANUP_LIMIT,
  listDeferredCanonicalThreadCleanupCandidates,
  makeDeferredCanonicalThreadCleanup,
} from "./CanonicalThreadCleanup.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const candidates = [
  {
    threadId: ThreadId.makeUnsafe("canonical-cleanup-covered"),
    deletionSequence: 17,
    covered: true,
  },
  {
    threadId: ThreadId.makeUnsafe("canonical-cleanup-deferred"),
    deletionSequence: 18,
    covered: false,
  },
] as const;

it.effect("deferred canonical thread cleanup", () =>
  Effect.gen(function* () {
    const attempted: string[] = [];
    const cleanup = makeDeferredCanonicalThreadCleanup({
      listCandidates: () => Effect.succeed(candidates),
      finalize: (candidate) => {
        attempted.push(candidate.threadId);
        return candidate.covered
          ? Effect.void
          : Effect.fail(new Error("baseline verification failed"));
      },
    });

    const dryRun = yield* cleanup(false);
    assert.equal(CANONICAL_THREAD_CLEANUP_LIMIT, 50);
    assert.equal(dryRun.cleanedCount, 0);
    assert.equal(dryRun.skippedCount, 2);
    assert.equal(dryRun.failedCount, 0);
    assert.deepEqual(attempted, []);

    const applied = yield* cleanup(true);
    assert.equal(applied.cleanedCount, 1);
    assert.equal(applied.skippedCount, 1);
    assert.equal(applied.failedCount, 0);
    assert.deepEqual(attempted, [candidates[0].threadId]);
    assert.deepEqual(
      applied.candidates.map((candidate) => candidate.outcome),
      ["cleaned", "skipped"],
    );
  }),
);

it.layer(Layer.provideMerge(Layer.empty, SqlitePersistenceMemory))(
  "deferred canonical thread cleanup candidates",
  (it) => {
    it.effect("lists only deletion roots and requires complete baseline coverage", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-08-18T00:00:00.000Z";
        const rootThreadId = ThreadId.makeUnsafe("canonical-cleanup-root");
        const childThreadId = ThreadId.makeUnsafe("canonical-cleanup-child");
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES ('canonical-cleanup-delete', 'thread', ${rootThreadId}, 0, 'thread.deleted', ${now},
            'canonical-cleanup-command', NULL, NULL, 'server', '{}', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES
            ('thread', ${rootThreadId}, 1, ${now}, 1),
            ('thread', ${childThreadId}, 1, ${now}, NULL)
        `;
        yield* sql`
          INSERT INTO projection_baselines (
            sequence, format_version, payload_json, payload_hash, verification_status,
            verification_detail, created_at, verified_at
          ) VALUES (1, 1, '{}', 'test', 'verified', NULL, ${now}, ${now})
        `;

        assert.deepEqual(yield* listDeferredCanonicalThreadCleanupCandidates(sql), []);

        yield* sql`
          UPDATE orchestration_deletion_markers
          SET covered_by_baseline_sequence = 1
          WHERE entity_kind = 'thread' AND entity_id = ${childThreadId}
        `;
        assert.deepEqual(yield* listDeferredCanonicalThreadCleanupCandidates(sql), [
          { threadId: rootThreadId, deletionSequence: 1, covered: true },
        ]);
      }),
    );
  },
);
