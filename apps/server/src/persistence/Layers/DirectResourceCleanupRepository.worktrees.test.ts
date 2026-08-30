import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DirectResourceCleanupRepository } from "../Services/DirectResourceCleanupRepository.ts";
import { DirectResourceCleanupRepositoryLive } from "./DirectResourceCleanupRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  DirectResourceCleanupRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-08-30T00:00:00.000Z";
const worktree = {
  kind: "managed-worktree" as const,
  relativePath: "project/thread",
  identity: {
    declaredPath: "/managed/project/thread",
    canonicalPath: "/managed/project/thread",
    device: 1,
    inode: 2,
    changedAtMs: 3,
    type: "directory" as const,
    root: { canonicalPath: "/managed", device: 1, inode: 1 },
    parent: { canonicalPath: "/managed/project", device: 1, inode: 4 },
  },
  quarantineName: ".bigbud-purge-thread",
  action: "delete" as const,
};

const prepareIntent = Effect.fn("prepareWorktreeIntent")(function* (suffix: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO direct_resource_cleanup_intents (
      intent_id, event_id, source_command_id, source_payload_digest_version,
      source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
    ) VALUES (${`intent-${suffix}`}, ${`event-${suffix}`}, ${`source-${suffix}`},
      'v1', 'source', 'thread', ${`thread-${suffix}`}, 'single', ${now})
  `;
  return sql;
});

layer("direct cleanup worktree manifests", (it) => {
  it.effect("persists immutable manifests atomically and gates them on proof plus pruning", () =>
    Effect.gen(function* () {
      const sql = yield* prepareIntent("persisted");
      const repository = yield* DirectResourceCleanupRepository;
      yield* repository.prepare({
        operationId: "operation-persisted",
        intentId: "intent-persisted",
        finalizeCommandId: "finalize-persisted",
        finalizePayloadJson: "{}",
        finalizePayloadDigestVersion: "v1",
        finalizePayloadDigest: "digest",
        planDigest: "plan-with-worktree",
        expectedPlatform: "darwin/arm64",
        resources: [],
        worktreeResources: [worktree],
        createdAt: now,
      });
      const [stored] = yield* sql<{
        readonly digest: string;
        readonly json: string;
        readonly state: string;
      }>`
        SELECT resource_digest AS digest, resource_json AS json, state
        FROM direct_resource_cleanup_worktrees
      `;
      assert.equal(stored!.digest.length, 64);
      assert.equal(stored!.state, "pending");
      assert.deepEqual(JSON.parse(stored!.json), worktree);
      assert.deepEqual(yield* repository.listEligibleWorktrees({ dueAt: now, limit: 10 }), []);
      yield* sql`
        INSERT INTO direct_resource_cleanup_proofs (
          operation_id, receipt_status, aggregate_kind, aggregate_id,
          payload_digest_version, payload_digest, event_id, event_sequence, event_type,
          event_payload_json, proof_digest, proven_at
        ) VALUES ('operation-persisted', 'accepted', 'thread', 'thread-persisted',
          'v1', 'digest', 'deleted-event', 1, 'thread.deleted', '{}',
          '0000000000000000000000000000000000000000000000000000000000000000', ${now})
      `;
      assert.deepEqual(yield* repository.listEligibleWorktrees({ dueAt: now, limit: 10 }), []);
      yield* repository.markCanonicalPruned("operation-persisted", now);
      const candidates = yield* repository.listEligibleWorktrees({ dueAt: now, limit: 10 });
      assert.equal(candidates.length, 1);
      assert.deepEqual(candidates[0]!.resource, worktree);
      const immutable = yield* Effect.exit(sql`
        UPDATE direct_resource_cleanup_worktrees SET resource_json = '{}'
      `);
      assert.equal(immutable._tag, "Failure");
    }),
  );

  it.effect("rolls the plan and worktrees back when preparation fails", () =>
    Effect.gen(function* () {
      const sql = yield* prepareIntent("rollback");
      const repository = yield* DirectResourceCleanupRepository;
      const exit = yield* Effect.exit(
        repository.prepare({
          operationId: "operation-rollback",
          intentId: "intent-rollback",
          finalizeCommandId: "finalize-rollback",
          finalizePayloadJson: "{}",
          finalizePayloadDigestVersion: "v1",
          finalizePayloadDigest: "digest",
          planDigest: "plan",
          expectedPlatform: "darwin/arm64",
          resources: [],
          worktreeResources: [{ ...worktree, quarantineName: "unsafe" }],
          createdAt: now,
        }),
      );
      assert.equal(exit._tag, "Failure");
      assert.equal(
        (yield* sql`
          SELECT 1 FROM direct_resource_cleanup_plans
          WHERE operation_id = 'operation-rollback'
        `).length,
        0,
      );
      assert.equal(
        (yield* sql`
          SELECT 1 FROM direct_resource_cleanup_worktrees
          WHERE operation_id = 'operation-rollback'
        `).length,
        0,
      );
    }),
  );
});
