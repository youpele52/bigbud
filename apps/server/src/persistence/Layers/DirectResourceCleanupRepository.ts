import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  DirectResourceCleanupRepository,
  type DirectResourceCleanupRepositoryShape,
} from "../Services/DirectResourceCleanupRepository.ts";
import { makeDirectResourceCleanupReconciliation } from "./DirectResourceCleanupRepository.recovery.ts";
import { makeDirectResourceCleanupPreparation } from "./DirectResourceCleanupRepository.prepare.ts";
import { makeDirectResourceCleanupProof } from "./DirectResourceCleanupRepository.proof.ts";
const terminalOutcomes = new Set([
  "removed",
  "already_absent",
  "resumed_and_removed",
  "identity_mismatch",
  "unsupported_entry",
]);
export const makeDirectResourceCleanupRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    ...makeDirectResourceCleanupPreparation(sql),
    ...makeDirectResourceCleanupProof(sql),
    cancelPrepared: (operationId, at) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const cancelled = yield* sql<{ readonly intentId: string }>`
              UPDATE direct_resource_cleanup_plans SET state = 'cancelled', completed_at = ${at},
                updated_at = ${at} WHERE operation_id = ${operationId} AND state = 'prepared'
              RETURNING intent_id AS "intentId"
            `;
            if (cancelled[0]) {
              yield* sql`
                UPDATE direct_resource_cleanup_intents SET state = 'cancelled', closed_at = ${at}
                WHERE intent_id = ${cancelled[0].intentId} AND state = 'open'
              `;
            }
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
    cancelIntentIfUnplanned: (intentId, at) =>
      sql`
        UPDATE direct_resource_cleanup_intents SET state = 'cancelled', closed_at = ${at}
        WHERE intent_id = ${intentId} AND state = 'open' AND NOT EXISTS (
          SELECT 1 FROM direct_resource_cleanup_plans
          WHERE intent_id = direct_resource_cleanup_intents.intent_id
        )
      `.pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(String(error))),
      ),
    recordResults: (operationId, leaseId, attemptId, results, at, retry) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (new Set(results.map((result) => result.resourceId)).size !== results.length) {
              return yield* Effect.fail(new Error("cleanup results contain duplicate resources"));
            }
            const lease = yield* sql`
              SELECT 1 FROM direct_resource_cleanup_plans
              WHERE operation_id = ${operationId} AND state = 'running'
                AND lease_id = ${leaseId} AND lease_expires_at > ${at}
            `;
            if (lease.length !== 1) return yield* Effect.fail(new Error("cleanup lease is stale"));
            const updates = yield* Effect.forEach(
              results,
              (result) =>
                sql<{ readonly resourceId: string }>`
              UPDATE direct_resource_cleanup_resources SET outcome = ${result.outcome},
                error_code = ${result.errorCode || null},
                terminal_at = ${terminalOutcomes.has(result.outcome) ? at : null}
              WHERE operation_id = ${operationId} AND resource_id = ${result.resourceId}
              RETURNING resource_id AS "resourceId"
            `,
              { concurrency: 1 },
            );
            if (updates.some((rows) => rows.length !== 1)) {
              return yield* Effect.fail(new Error("cleanup result references an unknown resource"));
            }
            const recorded = yield* sql`
              UPDATE direct_resource_cleanup_attempts SET state = 'recorded', updated_at = ${at}
              WHERE attempt_id = ${attemptId} AND operation_id = ${operationId}
                AND state IN ('sent', 'ambiguous')
              RETURNING attempt_id
            `;
            if (recorded.length !== 1) {
              return yield* Effect.fail(new Error("cleanup attempt is not recordable"));
            }
            if (retry) {
              yield* sql`
                UPDATE direct_resource_cleanup_plans SET attempt_count = attempt_count + 1,
                  state = 'retry', last_error_code = ${retry.errorCode},
                  next_attempt_at = ${retry.nextAttemptAt}, updated_at = ${at}
                WHERE operation_id = ${operationId} AND state = 'running'
                  AND lease_id = ${leaseId}
              `;
            }
          }),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((error) => new Error(String(error))),
        ),
    scheduleRetry: (operationId, leaseId, errorCode, nextAttemptAt, incrementAttempt) =>
      sql<{ readonly operationId: string }>`
        UPDATE direct_resource_cleanup_plans SET state = 'retry',
          attempt_count = attempt_count + ${incrementAttempt ? 1 : 0},
          last_error_code = ${errorCode}, next_attempt_at = ${nextAttemptAt},
          updated_at = ${new Date().toISOString()} WHERE operation_id = ${operationId}
          AND state = 'running' AND lease_id = ${leaseId}
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : Effect.fail(new Error("cleanup lease is stale")),
        ),
        Effect.mapError((error) => new Error(String(error))),
      ),
    block: (operationId, errorCode, at) =>
      sql`
        UPDATE direct_resource_cleanup_plans SET state = 'blocked', last_error_code = ${errorCode},
          updated_at = ${at} WHERE operation_id = ${operationId} AND state NOT IN ('completed', 'cancelled')
      `.pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(String(error))),
      ),
    complete: (operationId, at, leaseId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const completed = yield* sql`
            UPDATE direct_resource_cleanup_plans SET state = 'completed', completed_at = ${at},
              updated_at = ${at}, last_error_code = NULL WHERE operation_id = ${operationId}
              AND NOT EXISTS (SELECT 1 FROM direct_resource_cleanup_resources
                WHERE operation_id = ${operationId} AND terminal_at IS NULL)
              AND (${leaseId ?? null} IS NOT NULL AND state = 'running' AND lease_id = ${leaseId ?? null}
                OR ${leaseId ?? null} IS NULL AND state = 'ready' AND NOT EXISTS (
                  SELECT 1 FROM direct_resource_cleanup_resources
                  WHERE operation_id = ${operationId} AND terminal_at IS NULL
                )) RETURNING operation_id
          `;
            if (completed.length !== 1)
              return yield* Effect.fail(new Error("cleanup completion is not authorized"));
            yield* sql`
            UPDATE direct_resource_cleanup_intents SET state = 'completed', closed_at = ${at}
            WHERE intent_id = (SELECT intent_id FROM direct_resource_cleanup_plans
              WHERE operation_id = ${operationId})
          `;
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
    claimOperation: (input) =>
      sql`
        UPDATE direct_resource_cleanup_plans SET state = 'running', lease_id = ${input.leaseId},
          lease_expires_at = ${input.expiresAt}, updated_at = ${input.claimedAt}
        WHERE operation_id = ${input.operationId} AND state IN ('ready', 'retry')
          AND expected_platform = ${input.expectedPlatform}
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${input.claimedAt})
          AND (lease_id IS NULL OR lease_expires_at <= ${input.claimedAt})
        RETURNING operation_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((error) => new Error(String(error))),
      ),
    claimReady: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const plans = yield* sql<{
              readonly operationId: string;
              readonly attemptCount: number;
              readonly planDigest: string;
              readonly proofDigest: string;
            }>`
              SELECT plan.operation_id AS "operationId", plan.attempt_count AS "attemptCount",
                plan.plan_digest AS "planDigest", proof.proof_digest AS "proofDigest"
              FROM direct_resource_cleanup_plans AS plan
              JOIN direct_resource_cleanup_proofs AS proof ON proof.operation_id = plan.operation_id
              WHERE plan.state IN ('ready', 'retry')
                AND plan.expected_platform = ${input.expectedPlatform}
                AND (proof.aggregate_kind = 'project' OR proof.canonical_pruned_at IS NOT NULL)
                AND (plan.next_attempt_at IS NULL OR plan.next_attempt_at <= ${input.claimedAt})
                AND (plan.lease_id IS NULL OR plan.lease_expires_at <= ${input.claimedAt})
              ORDER BY COALESCE(plan.next_attempt_at, plan.created_at), plan.operation_id LIMIT 1
            `;
            const operationId = plans[0]?.operationId;
            if (!operationId) return undefined;
            const claimed = yield* sql`
              UPDATE direct_resource_cleanup_plans SET state = 'running', lease_id = ${input.leaseId},
                lease_expires_at = ${input.expiresAt}, updated_at = ${input.claimedAt}
              WHERE operation_id = ${operationId}
                AND (lease_id IS NULL OR lease_expires_at <= ${input.claimedAt})
              RETURNING operation_id
            `;
            if (claimed.length !== 1) return undefined;
            const resources = yield* sql<{
              readonly resourceId: string;
              readonly kind: import("../../deletion/Services/DirectResourceCleanupExecutor.ts").DirectCleanupResource["kind"];
              readonly relativePath: string;
              readonly quarantineName: string;
              readonly entryType: "file" | "directory" | null;
              readonly resourceDevice: string | null;
              readonly resourceFileId: string | null;
              readonly rootDevice: string;
              readonly rootFileId: string;
              readonly parentDevice: string;
              readonly parentFileId: string;
              readonly pageOrdinal: number;
            }>`
              SELECT resource_id AS "resourceId", resource_kind AS kind,
                relative_path AS "relativePath", quarantine_name AS "quarantineName",
                entry_type AS "entryType", resource_device AS "resourceDevice",
                resource_file_id AS "resourceFileId", root_device AS "rootDevice",
                root_file_id AS "rootFileId", parent_device AS "parentDevice",
                 parent_file_id AS "parentFileId", page_ordinal AS "pageOrdinal"
              FROM direct_resource_cleanup_resources
              WHERE operation_id = ${operationId} AND terminal_at IS NULL
              ORDER BY original_index
            `;
            return {
              operationId,
              attemptCount: plans[0]!.attemptCount,
              planDigest: plans[0]!.planDigest,
              proofDigest: plans[0]!.proofDigest,
              resources,
            };
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
    releaseLease: (operationId, leaseId) =>
      sql`
        UPDATE direct_resource_cleanup_plans SET lease_id = NULL, lease_expires_at = NULL,
          state = CASE WHEN state = 'running' THEN 'retry' ELSE state END
        WHERE operation_id = ${operationId} AND lease_id = ${leaseId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError((error) => new Error(String(error))),
      ),
    renewLease: (input) =>
      sql`
        UPDATE direct_resource_cleanup_plans SET lease_expires_at = ${input.expiresAt},
          updated_at = ${input.renewedAt}
        WHERE operation_id = ${input.operationId} AND state = 'running'
          AND lease_id = ${input.leaseId} AND lease_expires_at > ${input.renewedAt}
        RETURNING operation_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((error) => new Error(String(error))),
      ),
    prepareAttempt: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const lease = yield* sql`
              SELECT 1 FROM direct_resource_cleanup_plans
              WHERE operation_id = ${input.operationId} AND state = 'running'
                AND lease_id = ${input.leaseId} AND lease_expires_at > ${input.at}
            `;
            if (lease.length !== 1) return yield* Effect.fail(new Error("cleanup lease is stale"));
            const resourceIdsJson = JSON.stringify(input.resourceIds);
            const pageResources = yield* sql<{ readonly resourceId: string }>`
              SELECT resource_id AS "resourceId" FROM direct_resource_cleanup_resources
              WHERE operation_id = ${input.operationId} AND page_ordinal = ${input.pageOrdinal}
                AND terminal_at IS NULL ORDER BY original_index
            `;
            if (
              JSON.stringify(pageResources.map((resource) => resource.resourceId)) !==
              resourceIdsJson
            ) {
              return yield* Effect.fail(
                new Error("cleanup attempt resources conflict with immutable page"),
              );
            }
            yield* sql`
              INSERT INTO direct_resource_cleanup_attempts (
                attempt_id, operation_id, page_ordinal, page_digest, resource_ids_json,
                request_json, request_frame_hex, deadline_unix_ms, state, created_at, updated_at
              ) VALUES (
                ${input.attemptId}, ${input.operationId}, ${input.pageOrdinal},
                ${input.pageDigest}, ${resourceIdsJson}, ${input.requestJson},
                ${input.requestFrameHex}, ${input.deadlineUnixMs}, 'prepared', ${input.at}, ${input.at}
              ) ON CONFLICT(attempt_id) DO NOTHING
            `;
            const rows = yield* sql<{
              readonly pageDigest: string;
              readonly resourceIdsJson: string;
              readonly requestJson: string;
              readonly requestFrameHex: string;
              readonly deadlineUnixMs: number;
            }>`
              SELECT page_digest AS "pageDigest", resource_ids_json AS "resourceIdsJson",
                request_json AS "requestJson", request_frame_hex AS "requestFrameHex",
                deadline_unix_ms AS "deadlineUnixMs"
              FROM direct_resource_cleanup_attempts WHERE attempt_id = ${input.attemptId}
            `;
            if (
              rows[0]?.pageDigest !== input.pageDigest ||
              rows[0]?.resourceIdsJson !== resourceIdsJson ||
              rows[0]?.requestJson !== input.requestJson ||
              rows[0]?.requestFrameHex !== input.requestFrameHex ||
              rows[0]?.deadlineUnixMs !== input.deadlineUnixMs
            ) {
              return yield* Effect.fail(new Error("cleanup attempt conflicts with stored page"));
            }
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
    loadAmbiguousAttempt: (operationId, pageOrdinal) =>
      sql<{
        readonly attemptId: string;
        readonly pageDigest: string;
        readonly resourceIdsJson: string;
        readonly requestJson: string;
        readonly requestFrameHex: string;
        readonly deadlineUnixMs: number;
      }>`
        SELECT attempt_id AS "attemptId", page_digest AS "pageDigest",
          resource_ids_json AS "resourceIdsJson", request_json AS "requestJson",
          request_frame_hex AS "requestFrameHex", deadline_unix_ms AS "deadlineUnixMs"
        FROM direct_resource_cleanup_attempts
        WHERE operation_id = ${operationId} AND page_ordinal = ${pageOrdinal}
          AND state IN ('prepared', 'sent', 'ambiguous')
        ORDER BY created_at DESC, attempt_id DESC LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows[0]
            ? {
                attemptId: rows[0].attemptId,
                pageDigest: rows[0].pageDigest,
                resourceIds: JSON.parse(rows[0].resourceIdsJson) as ReadonlyArray<string>,
                requestJson: rows[0].requestJson,
                requestFrameHex: rows[0].requestFrameHex,
                deadlineUnixMs: rows[0].deadlineUnixMs,
              }
            : undefined,
        ),
        Effect.mapError((error) => new Error(String(error))),
      ),
    markAttempt: (attemptId, state, at, leaseId) =>
      sql<{ readonly attemptId: string }>`
        UPDATE direct_resource_cleanup_attempts SET state = ${state}, updated_at = ${at}
        WHERE attempt_id = ${attemptId} AND EXISTS (
          SELECT 1 FROM direct_resource_cleanup_plans AS plan
          WHERE plan.operation_id = direct_resource_cleanup_attempts.operation_id
            AND plan.state = 'running' AND plan.lease_id = ${leaseId}
            AND plan.lease_expires_at > ${at}
        ) RETURNING attempt_id AS "attemptId"
      `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : Effect.fail(new Error("cleanup lease is stale")),
        ),
        Effect.mapError((error) => new Error(String(error))),
      ),
    ...makeDirectResourceCleanupReconciliation(sql),
  } satisfies DirectResourceCleanupRepositoryShape;
});

export const DirectResourceCleanupRepositoryLive = Layer.effect(
  DirectResourceCleanupRepository,
  makeDirectResourceCleanupRepository,
);
