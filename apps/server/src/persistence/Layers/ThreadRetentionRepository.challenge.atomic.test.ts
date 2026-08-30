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

layer("thread retention confirmation transaction", (it) => {
  it.effect("rolls challenge consumption back when run persistence fails", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      const challenge = yield* repository.issueChallenge({
        challengeId: "atomic-confirmation",
        trigger: "manual",
        policy: "7-days",
        cutoffAt: "2026-08-01T00:00:00.000Z",
        issuedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T00:05:00.000Z",
      });
      yield* sql`
        CREATE TRIGGER fail_retention_run_insert BEFORE INSERT ON thread_retention_runs
        BEGIN SELECT RAISE(ABORT, 'run insert failed'); END
      `;
      const exit = yield* Effect.exit(
        repository.consumeChallengeAndCreateRun({
          token: challenge.token,
          trigger: "manual",
          runId: "atomic-run",
          consumedAt: "2026-08-04T00:01:00.000Z",
        }),
      );
      assert.equal(exit._tag, "Failure");
      const [stored] = yield* sql<{ readonly consumedAt: string | null }>`
        SELECT consumed_at AS "consumedAt"
        FROM thread_retention_consent_challenges
        WHERE token_hash = ${createHash("sha256").update(challenge.token).digest("hex")}
      `;
      assert.equal(stored!.consumedAt, null);
      assert.equal(
        (yield* sql`SELECT 1 FROM thread_retention_runs WHERE run_id = 'atomic-run'`).length,
        0,
      );
      yield* sql`DROP TRIGGER fail_retention_run_insert`;
    }),
  );
});
