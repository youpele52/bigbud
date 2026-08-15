import { createHash } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("thread retention consent", (it) => {
  it.effect("stores only a hash and enforces binding, expiry, and replay protection", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const issued = yield* repository.issueChallenge({
        challengeId: "hashed-challenge",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-07-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ tokenHash: string }>`
        SELECT token_hash AS "tokenHash" FROM thread_retention_consent_challenges
        WHERE challenge_id = 'hashed-challenge'
      `;
      assert.equal(rows[0]?.tokenHash, createHash("sha256").update(issued.token).digest("hex"));
      assert.notEqual(rows[0]?.tokenHash, issued.token);

      const exact = {
        token: issued.token,
        trigger: "manual" as const,
        policy: "7-days" as const,
        cutoffAt: issued.cutoffAt,
        consumedAt: "2026-08-04T00:04:00.000Z",
      };
      yield* repository.createOrGetActiveRun({
        runId: "active-run",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt: issued.cutoffAt,
        createdAt: "2026-08-04T00:03:00.000Z",
      });
      assert.equal(
        yield* repository.consumeChallenge({ ...exact, cutoffAt: "2026-07-02T00:00:00.000Z" }),
        "invalid",
      );
      const accepted = yield* repository.consumeChallengeAndCreateRun({
        token: exact.token,
        trigger: "manual",
        runId: "challenge-run",
        consumedAt: exact.consumedAt,
      });
      assert.isTrue(accepted.consumed);
      if (accepted.consumed) {
        assert.equal(accepted.run.runId, "challenge-run");
        assert.equal(accepted.run.status, "queued");
        assert.equal(accepted.run.policy, issued.policy);
        assert.equal(accepted.run.cutoffAt, issued.cutoffAt);
      }
      const replay = yield* repository.consumeChallengeAndCreateRun({
        token: exact.token,
        trigger: "manual",
        runId: "challenge-replay-run",
        consumedAt: exact.consumedAt,
      });
      assert.deepEqual(replay, { consumed: false, result: "already_consumed" });

      const expired = yield* repository.issueChallenge({
        challengeId: "expired-challenge",
        trigger: "policy-change",
        policy: "7-days",
        cutoffAt: "2026-07-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      assert.equal(
        yield* repository.consumeChallenge({
          token: expired.token,
          trigger: "policy-change",
          policy: "7-days",
          cutoffAt: expired.cutoffAt,
          consumedAt: "2026-08-04T00:05:00.001Z",
        }),
        "expired",
      );

      yield* repository.cleanupAudit({
        olderThan: "2026-08-05T00:00:00.000Z",
        keepLatest: 1,
      });
      const challengeRows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM thread_retention_consent_challenges
      `;
      assert.isAtMost(challengeRows[0]?.count ?? 0, 1);
    }),
  );

  it.effect("keeps concurrent manual confirmations with broader cutoffs distinct", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_consent_challenges`;
      yield* sql`DELETE FROM thread_retention_runs`;
      const first = yield* repository.issueChallenge({
        challengeId: "coalesce-first",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      const second = yield* repository.issueChallenge({
        challengeId: "coalesce-second",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:01:00.000Z",
        issuedAt: "2026-08-04T00:00:01.000Z",
        expiresAt: "2026-08-04T00:05:01.000Z",
      });

      const accepted = yield* Effect.all(
        [
          repository.consumeChallengeAndCreateRun({
            token: first.token,
            trigger: "manual",
            runId: "coalesced-first-run",
            consumedAt: "2026-08-04T00:02:00.000Z",
          }),
          repository.consumeChallengeAndCreateRun({
            token: second.token,
            trigger: "manual",
            runId: "coalesced-second-run",
            consumedAt: "2026-08-04T00:02:01.000Z",
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.isTrue(accepted.every((result) => result.consumed));
      const runs = accepted.flatMap((result) => (result.consumed ? [result.run] : []));
      assert.equal(new Set(runs.map((run) => run.runId)).size, 2);
      const created = accepted.filter((result) => result.consumed && result.created);
      assert.equal(created.length, 2);
      assert.equal(
        (yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM thread_retention_runs
             WHERE trigger_kind = 'manual' AND policy = '7-days'
              AND status NOT IN ('completed', 'completed_with_failures', 'failed', 'cancelled')
          `)[0]?.count,
        2,
      );
    }),
  );

  it.effect("does not coalesce an older confirmation into a broader active run", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_consent_challenges`;
      yield* sql`DELETE FROM thread_retention_runs`;
      const older = yield* repository.issueChallenge({
        challengeId: "older-scope",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      yield* repository.createOrGetActiveRun({
        runId: "broader-active",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:01:00.000Z",
        createdAt: "2026-08-04T00:00:01.000Z",
      });

      const accepted = yield* repository.consumeChallengeAndCreateRun({
        token: older.token,
        trigger: "manual",
        runId: "older-scope-run",
        consumedAt: "2026-08-04T00:01:00.000Z",
      });

      assert.isTrue(accepted.consumed);
      if (accepted.consumed) {
        assert.isTrue(accepted.created);
        assert.equal(accepted.run.runId, "older-scope-run");
        assert.equal(accepted.run.cutoffAt, "2026-08-01T00:00:00.000Z");
      }
    }),
  );

  it.effect("coalesces an exact equivalent active manual scope", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_consent_challenges`;
      yield* sql`DELETE FROM thread_retention_runs`;
      const challenge = yield* repository.issueChallenge({
        challengeId: "exact-scope",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      yield* repository.createOrGetActiveRun({
        runId: "exact-active",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-04T00:00:01.000Z",
      });

      const accepted = yield* repository.consumeChallengeAndCreateRun({
        token: challenge.token,
        trigger: "manual",
        runId: "unused-exact-run",
        consumedAt: "2026-08-04T00:01:00.000Z",
      });

      assert.isTrue(accepted.consumed);
      if (accepted.consumed) {
        assert.isFalse(accepted.created);
        assert.equal(accepted.run.runId, "exact-active");
        assert.equal(accepted.run.cutoffAt, "2026-08-01T00:00:00.000Z");
      }
    }),
  );

  it.effect("keeps broader manual confirmations distinct", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_retention_consent_challenges`;
      yield* sql`DELETE FROM thread_retention_runs`;
      yield* repository.createOrGetActiveRun({
        runId: "canonical-active",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      for (const runId of ["duplicate-one", "duplicate-two"]) {
        yield* repository.createQueuedRun({
          runId,
          trigger: "manual",
          policy: "7-days",
          cutoffAt: "2026-08-02T00:00:00.000Z",
          createdAt: "2026-08-04T00:00:01.000Z",
        });
      }
      const samePolicy = yield* repository.issueChallenge({
        challengeId: "collapse-pollution",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-03T00:00:00.000Z",
        issuedAt: "2026-08-04T00:01:00.000Z",
        expiresAt: "2026-08-04T00:06:00.000Z",
      });
      const coalesced = yield* repository.consumeChallengeAndCreateRun({
        token: samePolicy.token,
        trigger: "manual",
        runId: "unused-run",
        consumedAt: "2026-08-04T00:02:00.000Z",
      });
      assert.isTrue(coalesced.consumed);
      if (coalesced.consumed) assert.equal(coalesced.run.runId, "unused-run");
      assert.deepEqual(
        yield* sql<{ status: string }>`
          SELECT status FROM thread_retention_runs WHERE run_id LIKE 'duplicate-%' ORDER BY run_id
        `,
        [{ status: "queued" }, { status: "queued" }],
      );

      const differentPolicy = yield* repository.issueChallenge({
        challengeId: "different-policy",
        trigger: "manual",
        policy: "14-days",
        cutoffAt: "2026-08-02T00:00:00.000Z",
        issuedAt: "2026-08-04T00:03:00.000Z",
        expiresAt: "2026-08-04T00:08:00.000Z",
      });
      const distinct = yield* repository.consumeChallengeAndCreateRun({
        token: differentPolicy.token,
        trigger: "manual",
        runId: "different-policy-run",
        consumedAt: "2026-08-04T00:04:00.000Z",
      });
      assert.isTrue(distinct.consumed);
      if (distinct.consumed) assert.equal(distinct.run.runId, "different-policy-run");
    }),
  );
});
