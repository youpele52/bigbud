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
        policy: "14-days",
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
        policy: "14-days" as const,
        cutoffAt: issued.cutoffAt,
        consumedAt: "2026-08-04T00:04:00.000Z",
      };
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
        policy: "30-days",
        cutoffAt: "2026-07-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      assert.equal(
        yield* repository.consumeChallenge({
          token: expired.token,
          trigger: "policy-change",
          policy: "30-days",
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
});
