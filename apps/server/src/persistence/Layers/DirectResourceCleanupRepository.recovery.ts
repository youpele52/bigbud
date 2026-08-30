import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { DirectResourceCleanupRepositoryShape } from "../Services/DirectResourceCleanupRepository.ts";
import { directCleanupProofDigest } from "../../deletion/Layers/DirectResourceCleanup.proof.ts";

export function makeDirectResourceCleanupReconciliation(
  sql: SqlClient.SqlClient,
): Pick<
  DirectResourceCleanupRepositoryShape,
  | "reconcilePrepared"
  | "listCanonicalPruning"
  | "markCanonicalPruned"
  | "listRecoverableIntents"
  | "listPreparedFinalizeCandidates"
  | "blockPrepared"
> {
  return {
    listPreparedFinalizeCandidates: (input) =>
      sql<{
        readonly operationId: string;
        readonly createdAt: string;
        readonly finalizeCommandId: string;
        readonly finalizePayloadJson: string;
        readonly finalizePayloadDigestVersion: string;
        readonly finalizePayloadDigest: string;
      }>`
        SELECT plan.operation_id AS "operationId", plan.created_at AS "createdAt",
          plan.finalize_command_id AS "finalizeCommandId",
          plan.finalize_payload_json AS "finalizePayloadJson",
          plan.finalize_payload_digest_version AS "finalizePayloadDigestVersion",
          plan.finalize_payload_digest AS "finalizePayloadDigest"
        FROM direct_resource_cleanup_plans AS plan
        LEFT JOIN orchestration_command_receipts AS receipt
          ON receipt.command_id = plan.finalize_command_id
        LEFT JOIN orchestration_command_receipt_claims AS claim
          ON claim.command_id = plan.finalize_command_id
        WHERE plan.state = 'prepared' AND receipt.command_id IS NULL
          AND (plan.created_at > ${input.createdAfter}
            OR (plan.created_at = ${input.createdAfter}
              AND plan.operation_id > ${input.operationAfter}))
          AND (claim.command_id IS NULL OR (
            claim.payload_digest_version = plan.finalize_payload_digest_version
            AND claim.payload_digest = plan.finalize_payload_digest
          ))
        ORDER BY plan.created_at, plan.operation_id
        LIMIT ${Math.max(1, Math.min(100, Math.floor(input.limit)))}
      `.pipe(Effect.mapError((error) => new Error(String(error)))),
    blockPrepared: (operationId, errorCode, at) =>
      sql`
        UPDATE direct_resource_cleanup_plans SET state = 'blocked',
          last_error_code = ${errorCode}, updated_at = ${at}
        WHERE operation_id = ${operationId} AND state = 'prepared'
        RETURNING operation_id
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((error) => new Error(String(error))),
      ),
    listRecoverableIntents: (input) =>
      sql<{
        readonly intentId: string;
        readonly eventId: string;
        readonly commandId: string;
        readonly requestedAt: string;
      }>`
        SELECT intent.intent_id AS "intentId", intent.event_id AS "eventId",
          intent.source_command_id AS "commandId",
          intent.deletion_requested_at AS "requestedAt"
        FROM direct_resource_cleanup_intents AS intent
        LEFT JOIN direct_resource_cleanup_plans AS plan ON plan.intent_id = intent.intent_id
        LEFT JOIN projection_threads AS thread
          ON intent.entity_kind = 'thread' AND thread.thread_id = intent.entity_id
        LEFT JOIN projection_projects AS project
          ON intent.entity_kind = 'project' AND project.project_id = intent.entity_id
        WHERE intent.state = 'open' AND plan.operation_id IS NULL
          AND intent.source_command_id IS NOT NULL
          AND ((intent.entity_kind = 'thread' AND thread.deleting_at IS NOT NULL)
            OR (intent.entity_kind = 'project' AND project.deleting_at IS NOT NULL))
          AND (intent.deletion_requested_at > ${input.requestedAfter}
            OR (intent.deletion_requested_at = ${input.requestedAfter}
              AND intent.intent_id > ${input.intentAfter}))
        ORDER BY intent.deletion_requested_at, intent.intent_id
        LIMIT ${Math.max(1, Math.min(100, Math.floor(input.limit)))}
      `.pipe(Effect.mapError((error) => new Error(String(error)))),
    listCanonicalPruning: (limit) =>
      sql<{
        readonly operationId: string;
        readonly threadId: string;
        readonly deletionSequence: number;
      }>`
        SELECT proof.operation_id AS "operationId", proof.aggregate_id AS "threadId",
          proof.event_sequence AS "deletionSequence"
        FROM direct_resource_cleanup_proofs AS proof
        JOIN direct_resource_cleanup_plans AS plan ON plan.operation_id = proof.operation_id
        WHERE proof.aggregate_kind = 'thread' AND proof.canonical_pruned_at IS NULL
          AND plan.state IN ('ready', 'running', 'retry')
        ORDER BY proof.event_sequence LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}
      `.pipe(Effect.mapError((error) => new Error(String(error)))),
    markCanonicalPruned: (operationId, at) =>
      sql<{ readonly operationId: string }>`
        UPDATE direct_resource_cleanup_proofs SET canonical_pruned_at = ${at}
        WHERE operation_id = ${operationId} AND aggregate_kind = 'thread'
          AND canonical_pruned_at IS NULL
        RETURNING operation_id AS "operationId"
      `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.void
            : Effect.fail(new Error("canonical pruning checkpoint was not recorded")),
        ),
        Effect.mapError((error) => new Error(String(error))),
      ),
    reconcilePrepared: (at, expectedPlatform) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE direct_resource_cleanup_plans SET state = 'retry', lease_id = NULL,
                lease_expires_at = NULL, last_error_code = 'lease_expired', updated_at = ${at},
                next_attempt_at = ${at}
              WHERE state = 'running' AND lease_expires_at <= ${at}
            `;
            yield* sql`
              UPDATE direct_resource_cleanup_plans SET state = 'blocked',
                last_error_code = 'platform_mismatch', updated_at = ${at}
              WHERE state IN ('prepared', 'ready', 'retry')
                AND expected_platform != ${expectedPlatform}
            `;
            yield* sql`
              UPDATE direct_resource_cleanup_plans AS plan
              SET state = 'blocked', last_error_code = 'finalize_digest_conflict', updated_at = ${at}
              WHERE plan.state = 'prepared' AND EXISTS (
                SELECT 1 FROM orchestration_command_receipt_claims AS claim
                WHERE claim.command_id = plan.finalize_command_id
                  AND (claim.payload_digest_version != plan.finalize_payload_digest_version
                    OR claim.payload_digest != plan.finalize_payload_digest)
              )
            `;
            const rejected = yield* sql<{ readonly operationId: string }>`
              UPDATE direct_resource_cleanup_plans AS plan
              SET state = 'cancelled', completed_at = ${at}, updated_at = ${at},
                last_error_code = 'finalize_rejected'
              WHERE plan.state = 'prepared' AND EXISTS (
                SELECT 1 FROM orchestration_command_receipts AS receipt
                WHERE receipt.command_id = plan.finalize_command_id AND receipt.status = 'rejected'
              ) RETURNING operation_id AS "operationId"
            `;
            yield* Effect.forEach(
              rejected,
              (row) => sql`
                UPDATE direct_resource_cleanup_intents SET state = 'cancelled', closed_at = ${at}
                WHERE intent_id = (SELECT intent_id FROM direct_resource_cleanup_plans
                  WHERE operation_id = ${row.operationId})
              `,
              { concurrency: 1, discard: true },
            );
            const rows = yield* sql<{
              readonly operationId: string;
              readonly aggregateKind: "thread" | "project";
              readonly aggregateId: string;
              readonly digestVersion: string;
              readonly digest: string;
              readonly eventId: string;
              readonly eventSequence: number;
              readonly eventType: string;
              readonly eventPayloadJson: string;
            }>`
              SELECT plan.operation_id AS "operationId", intent.entity_kind AS "aggregateKind",
                intent.entity_id AS "aggregateId",
                plan.finalize_payload_digest_version AS "digestVersion",
                plan.finalize_payload_digest AS digest, event.event_id AS "eventId",
                event.sequence AS "eventSequence", event.event_type AS "eventType",
                event.payload_json AS "eventPayloadJson"
              FROM direct_resource_cleanup_plans AS plan
              JOIN direct_resource_cleanup_intents AS intent ON intent.intent_id = plan.intent_id
              JOIN orchestration_command_receipts AS receipt
                ON receipt.command_id = plan.finalize_command_id AND receipt.status = 'accepted'
                AND receipt.payload_digest_version = plan.finalize_payload_digest_version
                AND receipt.payload_digest = plan.finalize_payload_digest
              JOIN orchestration_events AS event ON event.command_id = plan.finalize_command_id
                AND event.aggregate_kind = intent.entity_kind AND event.stream_id = intent.entity_id
                AND event.event_type = CASE intent.entity_kind
                  WHEN 'thread' THEN 'thread.deleted' ELSE 'project.deleted' END
                AND json_extract(event.payload_json, CASE intent.entity_kind
                  WHEN 'thread' THEN '$.threadId' ELSE '$.projectId' END) = intent.entity_id
                AND json_extract(event.payload_json, '$.deletedAt') =
                  json_extract(plan.finalize_payload_json, '$.createdAt')
                AND (intent.entity_kind = 'project' OR
                  json_extract(event.payload_json, '$.threadIds') =
                    json_extract(plan.finalize_payload_json, '$.threadIds'))
              WHERE plan.state = 'prepared' ORDER BY plan.created_at LIMIT 100
            `;
            yield* Effect.forEach(
              rows,
              (row) =>
                sql`
                  INSERT INTO direct_resource_cleanup_proofs (
                    operation_id, receipt_status, aggregate_kind, aggregate_id,
                    payload_digest_version, payload_digest, event_id, event_sequence,
                    event_type, event_payload_json, proof_digest, proven_at, canonical_pruned_at
                  ) VALUES (
                    ${row.operationId}, 'accepted', ${row.aggregateKind}, ${row.aggregateId},
                    ${row.digestVersion}, ${row.digest}, ${row.eventId}, ${row.eventSequence},
                    ${row.eventType}, ${row.eventPayloadJson},
                    ${directCleanupProofDigest({
                      operationId: row.operationId,
                      payloadDigestVersion: row.digestVersion,
                      payloadDigest: row.digest,
                      eventId: row.eventId,
                      eventSequence: row.eventSequence,
                      eventType: row.eventType,
                      eventPayloadJson: row.eventPayloadJson,
                    })}, ${at},
                    ${row.aggregateKind === "project" ? at : null}
                  ) ON CONFLICT(operation_id) DO NOTHING
                `.pipe(
                  Effect.andThen(sql`
                    UPDATE direct_resource_cleanup_plans SET state = 'ready', updated_at = ${at}
                    WHERE operation_id = ${row.operationId} AND state = 'prepared'
                      AND EXISTS (
                        SELECT 1 FROM direct_resource_cleanup_proofs AS proof
                        WHERE proof.operation_id = ${row.operationId}
                          AND proof.receipt_status = 'accepted'
                          AND proof.aggregate_kind = ${row.aggregateKind}
                          AND proof.aggregate_id = ${row.aggregateId}
                          AND proof.payload_digest_version = ${row.digestVersion}
                          AND proof.payload_digest = ${row.digest}
                          AND proof.event_id = ${row.eventId}
                      )
                  `),
                ),
              { concurrency: 1, discard: true },
            );
            return rows.length;
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
  };
}
