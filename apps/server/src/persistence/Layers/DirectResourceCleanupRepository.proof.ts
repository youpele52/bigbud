import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { directCleanupProofDigest } from "../../deletion/Layers/DirectResourceCleanup.proof.ts";
import type { DirectResourceCleanupRepositoryShape } from "../Services/DirectResourceCleanupRepository.ts";

export function makeDirectResourceCleanupProof(
  sql: SqlClient.SqlClient,
): Pick<DirectResourceCleanupRepositoryShape, "markFinalizeCommitted"> {
  return {
    markFinalizeCommitted: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const plan = yield* sql<{
              readonly digestVersion: string;
              readonly digest: string;
              readonly aggregateKind: "thread" | "project";
              readonly aggregateId: string;
              readonly receiptStatus: string;
              readonly eventId: string;
              readonly eventSequence: number;
              readonly eventType: string;
              readonly eventPayloadJson: string;
            }>`
              SELECT plan.finalize_payload_digest_version AS "digestVersion",
                plan.finalize_payload_digest AS digest, intent.entity_kind AS "aggregateKind",
                intent.entity_id AS "aggregateId", receipt.status AS "receiptStatus",
                event.event_id AS "eventId", event.sequence AS "eventSequence",
                event.event_type AS "eventType", event.payload_json AS "eventPayloadJson"
              FROM direct_resource_cleanup_plans AS plan
              JOIN direct_resource_cleanup_intents AS intent ON intent.intent_id = plan.intent_id
              JOIN orchestration_command_receipts AS receipt
                ON receipt.command_id = plan.finalize_command_id
                AND receipt.payload_digest_version = plan.finalize_payload_digest_version
                AND receipt.payload_digest = plan.finalize_payload_digest
              JOIN orchestration_events AS event ON event.command_id = plan.finalize_command_id
                AND event.event_id = ${input.eventId}
                AND event.aggregate_kind = intent.entity_kind AND event.stream_id = intent.entity_id
                AND json_extract(event.payload_json, CASE intent.entity_kind
                  WHEN 'thread' THEN '$.threadId' ELSE '$.projectId' END) = intent.entity_id
                AND json_extract(event.payload_json, '$.deletedAt') =
                  json_extract(plan.finalize_payload_json, '$.createdAt')
                AND (intent.entity_kind = 'project' OR
                  json_extract(event.payload_json, '$.threadIds') =
                    json_extract(plan.finalize_payload_json, '$.threadIds'))
              WHERE plan.operation_id = ${input.operationId}
            `;
            const expectedEventType =
              input.aggregateKind === "thread" ? "thread.deleted" : "project.deleted";
            if (
              plan[0]?.digestVersion !== input.payloadDigestVersion ||
              plan[0]?.digest !== input.payloadDigest ||
              plan[0]?.aggregateKind !== input.aggregateKind ||
              plan[0]?.aggregateId !== input.aggregateId ||
              plan[0]?.receiptStatus !== "accepted" ||
              plan[0]?.eventId !== input.eventId ||
              plan[0]?.eventSequence !== input.eventSequence ||
              plan[0]?.eventType !== expectedEventType ||
              plan[0]?.eventType !== input.eventType ||
              plan[0]?.eventPayloadJson !== input.eventPayloadJson
            ) {
              return yield* Effect.fail(new Error("finalize receipt or event proof mismatch"));
            }
            const existingProof = yield* sql<{
              readonly aggregateKind: string;
              readonly aggregateId: string;
              readonly digestVersion: string;
              readonly digest: string;
              readonly eventId: string;
              readonly eventSequence: number;
              readonly eventType: string;
              readonly eventPayloadJson: string;
              readonly proofDigest: string;
            }>`
              SELECT aggregate_kind AS "aggregateKind", aggregate_id AS "aggregateId",
                payload_digest_version AS "digestVersion", payload_digest AS digest,
                event_id AS "eventId", event_sequence AS "eventSequence",
                event_type AS "eventType", event_payload_json AS "eventPayloadJson",
                proof_digest AS "proofDigest"
              FROM direct_resource_cleanup_proofs WHERE operation_id = ${input.operationId}
            `;
            if (
              existingProof[0] &&
              (existingProof[0].aggregateKind !== input.aggregateKind ||
                existingProof[0].aggregateId !== input.aggregateId ||
                existingProof[0].digestVersion !== input.payloadDigestVersion ||
                existingProof[0].digest !== input.payloadDigest ||
                existingProof[0].eventId !== input.eventId ||
                existingProof[0].eventSequence !== input.eventSequence ||
                existingProof[0].eventType !== input.eventType ||
                existingProof[0].eventPayloadJson !== input.eventPayloadJson)
            ) {
              return yield* Effect.fail(new Error("cleanup proof conflicts with stored snapshot"));
            }
            const proofDigest = directCleanupProofDigest(input);
            if (
              existingProof[0]?.proofDigest !== undefined &&
              existingProof[0].proofDigest !== proofDigest
            ) {
              return yield* Effect.fail(
                new Error("cleanup proof digest conflicts with stored snapshot"),
              );
            }
            yield* sql`
              INSERT INTO direct_resource_cleanup_proofs (
                operation_id, receipt_status, aggregate_kind, aggregate_id,
                payload_digest_version, payload_digest, event_id, event_sequence,
                event_type, event_payload_json, proof_digest, proven_at, canonical_pruned_at
              ) VALUES (
                ${input.operationId}, 'accepted', ${input.aggregateKind}, ${input.aggregateId},
                ${input.payloadDigestVersion}, ${input.payloadDigest}, ${input.eventId},
                ${input.eventSequence}, ${input.eventType}, ${input.eventPayloadJson}, ${proofDigest}, ${input.provenAt},
                ${input.aggregateKind === "project" ? input.provenAt : null}
              ) ON CONFLICT(operation_id) DO NOTHING
            `;
            yield* sql`
              UPDATE direct_resource_cleanup_plans SET state = 'ready', updated_at = ${input.provenAt}
              WHERE operation_id = ${input.operationId} AND state = 'prepared'
                AND EXISTS (SELECT 1 FROM direct_resource_cleanup_proofs
                  WHERE operation_id = ${input.operationId})
            `;
          }),
        )
        .pipe(Effect.mapError((error) => new Error(String(error)))),
  };
}
