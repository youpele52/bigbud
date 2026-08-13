import { createHash, randomBytes } from "node:crypto";

import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  CreateRetentionRunInput,
  RetentionChallenge,
  ThreadRetentionRun,
} from "../Services/ThreadRetentionRepository.ts";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function makeThreadRetentionChallenges<E, R>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly createQueuedRun: (
    run: CreateRetentionRunInput,
  ) => Effect.Effect<ThreadRetentionRun, E, R>;
}) {
  const issueChallenge = (
    challenge: import("../Services/ThreadRetentionRepository.ts").IssueRetentionChallengeInput,
  ) => {
    const token = randomBytes(32).toString("base64url");
    return input.sql.withTransaction(
      Effect.gen(function* () {
        yield* input.sql`
          DELETE FROM thread_retention_consent_challenges
          WHERE consumed_at IS NOT NULL OR expires_at < ${challenge.issuedAt}
        `;
        yield* input.sql`INSERT INTO thread_retention_consent_challenges (
          challenge_id, token_hash, trigger_kind, policy, cutoff_at, expires_at, issued_at
        ) VALUES (${challenge.challengeId}, ${tokenHash(token)}, ${challenge.trigger}, ${challenge.policy},
          ${challenge.cutoffAt}, ${challenge.expiresAt}, ${challenge.issuedAt})`;
        yield* input.sql`
          DELETE FROM thread_retention_consent_challenges
          WHERE challenge_id IN (
            SELECT challenge_id FROM thread_retention_consent_challenges
            ORDER BY issued_at DESC, challenge_id DESC LIMIT -1 OFFSET 32
          )
        `;
        return { ...challenge, token };
      }),
    );
  };

  const consumeChallenge = (
    challenge: import("../Services/ThreadRetentionRepository.ts").ConsumeRetentionChallengeInput,
  ) =>
    input.sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* input.sql<{
          challengeId: string;
          trigger: string;
          policy: string;
          cutoffAt: string;
          expiresAt: string;
          consumedAt: string | null;
        }>`
          SELECT challenge_id AS "challengeId", trigger_kind AS trigger, policy,
            cutoff_at AS "cutoffAt", expires_at AS "expiresAt", consumed_at AS "consumedAt"
          FROM thread_retention_consent_challenges
          WHERE token_hash = ${tokenHash(challenge.token)} LIMIT 1
        `;
        const row = rows[0];
        if (
          row === undefined ||
          row.trigger !== challenge.trigger ||
          row.policy !== challenge.policy ||
          row.cutoffAt !== challenge.cutoffAt
        )
          return "invalid";
        if (row.consumedAt !== null) return "already_consumed";
        if (row.expiresAt < challenge.consumedAt) return "expired";
        const consumed = yield* input.sql`
          UPDATE thread_retention_consent_challenges SET consumed_at = ${challenge.consumedAt}
          WHERE challenge_id = ${row.challengeId} AND consumed_at IS NULL
            AND expires_at >= ${challenge.consumedAt}
          RETURNING challenge_id
        `;
        return consumed.length === 1 ? "consumed" : "invalid";
      }),
    );

  const readChallenge = (token: string) =>
    input.sql<RetentionChallenge>`
      SELECT challenge_id AS "challengeId", trigger_kind AS trigger, policy,
        cutoff_at AS "cutoffAt", issued_at AS "issuedAt", expires_at AS "expiresAt",
        consumed_at AS "consumedAt"
      FROM thread_retention_consent_challenges
      WHERE token_hash = ${tokenHash(token)} LIMIT 1
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const consumeChallengeAndCreateRun = (request: {
    readonly token: string;
    readonly trigger: "manual";
    readonly runId: string;
    readonly consumedAt: string;
  }) =>
    input.sql.withTransaction(
      Effect.gen(function* () {
        const challenge = yield* readChallenge(request.token);
        if (Option.isNone(challenge) || challenge.value.trigger !== request.trigger) {
          return { consumed: false, result: "invalid" } as const;
        }
        const result = yield* consumeChallenge({
          token: request.token,
          trigger: request.trigger,
          policy: challenge.value.policy,
          cutoffAt: challenge.value.cutoffAt,
          consumedAt: request.consumedAt,
        });
        if (result !== "consumed") return { consumed: false, result } as const;
        return {
          consumed: true,
          run: yield* input.createQueuedRun({
            runId: request.runId,
            trigger: request.trigger,
            policy: challenge.value.policy,
            cutoffAt: challenge.value.cutoffAt,
            createdAt: request.consumedAt,
          }),
        } as const;
      }),
    );

  const consumePolicyChallenge = (request: {
    readonly token: string;
    readonly policy: RetentionChallenge["policy"];
    readonly consumedAt: string;
  }) =>
    input.sql.withTransaction(
      Effect.gen(function* () {
        const challenge = yield* readChallenge(request.token);
        if (
          Option.isNone(challenge) ||
          challenge.value.trigger !== "policy-change" ||
          challenge.value.policy !== request.policy
        ) {
          return "invalid" as const;
        }
        const result = yield* consumeChallenge({
          token: request.token,
          trigger: "policy-change",
          policy: request.policy,
          cutoffAt: challenge.value.cutoffAt,
          consumedAt: request.consumedAt,
        });
        if (result !== "consumed") return result;
        return "consumed" as const;
      }),
    );

  return {
    issueChallenge,
    consumeChallenge,
    readChallenge,
    consumeChallengeAndCreateRun,
    consumePolicyChallenge,
  };
}
