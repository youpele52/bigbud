import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  GetByCommandIdInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type CommandReceiptClaimResult,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../Services/OrchestrationCommandReceipts.ts";

const LEGACY_UNBOUND_DIGEST_VERSION = "legacy-unbound/v0";
const LEGACY_UNBOUND_DIGEST = "unavailable";

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          rejection_reason,
          error,
          payload_digest_version,
          payload_digest
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.rejectionReason},
          ${receipt.error},
          ${receipt.payloadDigestVersion},
          ${receipt.payloadDigest}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
          aggregate_id = excluded.aggregate_id,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          rejection_reason = excluded.rejection_reason,
          error = excluded.error,
          payload_digest_version = excluded.payload_digest_version,
          payload_digest = excluded.payload_digest
        WHERE orchestration_command_receipts.status != 'accepted'
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          rejection_reason AS "rejectionReason",
          error,
          payload_digest_version AS "payloadDigestVersion",
          payload_digest AS "payloadDigest"
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const upsert: OrchestrationCommandReceiptRepositoryShape["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape["getByCommandId"] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  const claimOrInspect: OrchestrationCommandReceiptRepositoryShape["claimOrInspect"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO orchestration_command_receipt_claims (
            command_id,
            payload_digest_version,
            payload_digest,
            claimed_at
          )
          VALUES (
            ${input.commandId},
            ${input.payloadDigestVersion},
            ${input.payloadDigest},
            ${input.claimedAt}
          )
          ON CONFLICT(command_id) DO NOTHING
        `;
          const rows = (yield* sql`
          SELECT
            c.payload_digest_version AS "claimedPayloadDigestVersion",
            c.payload_digest AS "claimedPayloadDigest",
            r.command_id AS "commandId",
            r.aggregate_kind AS "aggregateKind",
            r.aggregate_id AS "aggregateId",
            r.accepted_at AS "acceptedAt",
            r.result_sequence AS "resultSequence",
            r.status,
            r.rejection_reason AS "rejectionReason",
            r.error,
            r.payload_digest_version AS "payloadDigestVersion",
            r.payload_digest AS "payloadDigest"
          FROM orchestration_command_receipt_claims c
          LEFT JOIN orchestration_command_receipts r ON r.command_id = c.command_id
          WHERE c.command_id = ${input.commandId}
        `) as ReadonlyArray<
            {
              readonly claimedPayloadDigestVersion: string;
              readonly claimedPayloadDigest: string;
            } & Partial<OrchestrationCommandReceipt>
          >;
          const row = rows[0];
          if (!row) return { status: "claimed" } satisfies CommandReceiptClaimResult;
          if (row.commandId && (row.payloadDigestVersion === null || row.payloadDigest === null)) {
            return {
              status: "conflict",
              storedPayloadDigestVersion: LEGACY_UNBOUND_DIGEST_VERSION,
              storedPayloadDigest: LEGACY_UNBOUND_DIGEST,
            } satisfies CommandReceiptClaimResult;
          }
          const storedVersion = row.payloadDigestVersion ?? row.claimedPayloadDigestVersion;
          const storedDigest = row.payloadDigest ?? row.claimedPayloadDigest;
          if (
            storedVersion !== input.payloadDigestVersion ||
            storedDigest !== input.payloadDigest
          ) {
            return {
              status: "conflict",
              storedPayloadDigestVersion: storedVersion,
              storedPayloadDigest: storedDigest,
            } satisfies CommandReceiptClaimResult;
          }
          if (
            row.commandId &&
            row.aggregateKind &&
            row.aggregateId &&
            row.acceptedAt &&
            row.resultSequence !== undefined &&
            row.status
          ) {
            return {
              status: "existing",
              receipt: {
                commandId: row.commandId,
                aggregateKind: row.aggregateKind,
                aggregateId: row.aggregateId,
                acceptedAt: row.acceptedAt,
                resultSequence: row.resultSequence,
                status: row.status,
                rejectionReason: row.rejectionReason ?? null,
                error: row.error ?? null,
                payloadDigestVersion: row.payloadDigestVersion ?? null,
                payloadDigest: row.payloadDigest ?? null,
              },
            } satisfies CommandReceiptClaimResult;
          }
          return { status: "claimed" } satisfies CommandReceiptClaimResult;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationCommandReceiptRepository.claimOrInspect:query"),
        ),
      );

  return {
    upsert,
    getByCommandId,
    claimOrInspect,
  } satisfies OrchestrationCommandReceiptRepositoryShape;
});

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
