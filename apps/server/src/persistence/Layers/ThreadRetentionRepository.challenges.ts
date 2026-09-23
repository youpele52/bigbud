import { createHash, randomBytes } from "node:crypto";

import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  CreateRetentionRunInput,
  RetentionChallenge,
  ThreadRetentionRun,
} from "../Services/ThreadRetentionRepository.ts";
import { THREAD_RETENTION_NONTERMINAL_RUN_STATUSES } from "../Services/ThreadRetentionRepository.ts";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function makeThreadRetentionChallenges<E, R>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly getRun: (runId: string) => Effect.Effect<Option.Option<ThreadRetentionRun>, E, R>;
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
          challenge_id, token_hash, trigger_kind, policy, selection_mode,
          age_criterion, cutoff_at, expires_at, issued_at
        ) VALUES (${challenge.challengeId}, ${tokenHash(token)}, ${challenge.trigger}, ${challenge.policy},
          ${challenge.selectionMode ?? "per-thread"},
          ${challenge.ageCriterion ?? "last-conversation-activity"},
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
          selectionMode: string;
          ageCriterion: string;
          cutoffAt: string;
          expiresAt: string;
          consumedAt: string | null;
        }>`
          SELECT challenge_id AS "challengeId", trigger_kind AS trigger, policy,
            selection_mode AS "selectionMode", age_criterion AS "ageCriterion",
            cutoff_at AS "cutoffAt", expires_at AS "expiresAt", consumed_at AS "consumedAt"
          FROM thread_retention_consent_challenges
          WHERE token_hash = ${tokenHash(challenge.token)} LIMIT 1
        `;
        const row = rows[0];
        if (
          row === undefined ||
          row.trigger !== challenge.trigger ||
          row.policy !== challenge.policy ||
          row.selectionMode !== (challenge.selectionMode ?? "per-thread") ||
          row.ageCriterion !== (challenge.ageCriterion ?? "last-conversation-activity") ||
          row.cutoffAt !== challenge.cutoffAt
        )
          return "invalid";
        if (row.consumedAt !== null) return "already_consumed";
        if (row.expiresAt < challenge.consumedAt) return "expired";
        const consumed = yield* input.sql`
          UPDATE thread_retention_consent_challenges SET consumed_at = ${challenge.consumedAt}
          WHERE challenge_id = ${row.challengeId} AND consumed_at IS NULL
            AND selection_mode = ${row.selectionMode} AND age_criterion = ${row.ageCriterion}
            AND expires_at >= ${challenge.consumedAt}
          RETURNING challenge_id
        `;
        return consumed.length === 1 ? "consumed" : "invalid";
      }),
    );

  const readChallenge = (token: string) =>
    input.sql<RetentionChallenge>`
      SELECT challenge_id AS "challengeId", trigger_kind AS trigger, policy,
        selection_mode AS "selectionMode", age_criterion AS "ageCriterion",
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
        if (
          Option.isNone(challenge) ||
          challenge.value.trigger !== request.trigger ||
          challenge.value.selectionMode !== "per-thread"
        ) {
          return { consumed: false, result: "invalid" } as const;
        }
        const result = yield* consumeChallenge({
          token: request.token,
          trigger: request.trigger,
          policy: challenge.value.policy,
          selectionMode: challenge.value.selectionMode,
          ageCriterion: challenge.value.ageCriterion,
          cutoffAt: challenge.value.cutoffAt,
          consumedAt: request.consumedAt,
        });
        if (result !== "consumed") return { consumed: false, result } as const;
        const equivalent = yield* input.sql<{ runId: string; cutoffAt: string }>`
          SELECT run_id AS "runId", cutoff_at AS "cutoffAt" FROM thread_retention_runs
          WHERE trigger_kind = 'manual' AND policy = ${challenge.value.policy}
            AND selection_mode = ${challenge.value.selectionMode ?? "legacy-subtree"}
            AND age_criterion = ${challenge.value.ageCriterion ?? "last-conversation-activity"}
            AND status IN ${input.sql.in(THREAD_RETENTION_NONTERMINAL_RUN_STATUSES)}
            AND cutoff_at = ${challenge.value.cutoffAt}
          ORDER BY CASE WHEN active_slot = 1 THEN 0 ELSE 1 END,
            cutoff_at DESC, created_at ASC, run_id ASC
          LIMIT 1
        `;
        const canonical = equivalent[0];
        if (canonical !== undefined) {
          yield* input.sql`
            UPDATE thread_retention_runs SET status = 'cancelled', completed_at = ${request.consumedAt},
              updated_at = ${request.consumedAt}, active_slot = NULL
            WHERE trigger_kind = 'manual' AND policy = ${challenge.value.policy}
              AND selection_mode = ${challenge.value.selectionMode ?? "legacy-subtree"}
              AND age_criterion = ${challenge.value.ageCriterion ?? "last-conversation-activity"}
              AND run_id <> ${canonical.runId} AND status = 'queued' AND active_slot IS NULL
              AND cutoff_at = ${canonical.cutoffAt}
              AND selected_count = 0 AND requested_count = 0
              AND NOT EXISTS (
                SELECT 1 FROM thread_retention_run_items AS item
                WHERE item.run_id = thread_retention_runs.run_id
              )
          `;
          const run = yield* input.getRun(canonical.runId);
          if (Option.isNone(run)) return yield* Effect.die("retention run disappeared");
          return { consumed: true, run: run.value, created: false } as const;
        }
        return {
          consumed: true,
          run: yield* input.createQueuedRun({
            runId: request.runId,
            trigger: request.trigger,
            policy: challenge.value.policy,
            selectionMode: challenge.value.selectionMode,
            ageCriterion: challenge.value.ageCriterion,
            cutoffAt: challenge.value.cutoffAt,
            createdAt: request.consumedAt,
          }),
          created: true,
        } as const;
      }),
    );

  const consumeManualChallenge = (request: {
    readonly token: string;
    readonly consumedAt: string;
  }) =>
    input.sql.withTransaction(
      Effect.gen(function* () {
        const challenge = yield* readChallenge(request.token);
        if (Option.isNone(challenge) || challenge.value.trigger !== "manual") {
          return { consumed: false, result: "invalid" } as const;
        }
        const result = yield* consumeChallenge({
          token: request.token,
          trigger: "manual",
          policy: challenge.value.policy,
          selectionMode: challenge.value.selectionMode,
          ageCriterion: challenge.value.ageCriterion,
          cutoffAt: challenge.value.cutoffAt,
          consumedAt: request.consumedAt,
        });
        return result === "consumed"
          ? ({
              consumed: true,
              policy: challenge.value.policy,
              selectionMode: challenge.value.selectionMode,
              ageCriterion: challenge.value.ageCriterion,
              cutoffAt: challenge.value.cutoffAt,
            } as const)
          : ({ consumed: false, result } as const);
      }),
    );

  const consumePolicyChallenge = (request: {
    readonly token: string;
    readonly policy: RetentionChallenge["policy"];
    readonly ageCriterion?: RetentionChallenge["ageCriterion"];
    readonly consumedAt: string;
  }) =>
    input.sql.withTransaction(
      Effect.gen(function* () {
        const challenge = yield* readChallenge(request.token);
        if (
          Option.isNone(challenge) ||
          challenge.value.trigger !== "policy-change" ||
          challenge.value.policy !== request.policy ||
          challenge.value.selectionMode !== "per-thread" ||
          challenge.value.ageCriterion !== (request.ageCriterion ?? "last-conversation-activity")
        ) {
          return "invalid" as const;
        }
        const result = yield* consumeChallenge({
          token: request.token,
          trigger: "policy-change",
          policy: request.policy,
          selectionMode: "per-thread",
          ageCriterion: request.ageCriterion ?? "last-conversation-activity",
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
    consumeManualChallenge,
    consumePolicyChallenge,
  };
}
