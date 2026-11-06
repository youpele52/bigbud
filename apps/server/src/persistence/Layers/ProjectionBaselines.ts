import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import { orchestrationSequenceFrontierSql } from "../OrchestrationSequenceFrontier.ts";
import {
  BASELINE_SCRATCH_ID,
  PROJECTION_BASELINE_FORMAT_VERSION,
  storedBaselinePayloadSource,
} from "../ProjectionBaselineRows.ts";
import {
  ProjectionBaselineRepository,
  type ProjectionBaseline,
  type ProjectionBaselineRepositoryShape,
} from "../Services/ProjectionBaselines.ts";
import { captureBaselineRows } from "./ProjectionBaselines.capture.ts";
import { makeLatestVerifiedSequence } from "./ProjectionBaselines.queries.ts";
import { restoreBaselinePayload } from "./ProjectionBaselines.restoreRows.ts";

export { PROJECTION_BASELINE_FORMAT_VERSION };

type BaselineRow = {
  readonly baselineId: number;
  readonly sequence: number;
  readonly formatVersion: number;
  readonly payloadHash: string;
  readonly verificationStatus: "candidate" | "verified" | "rejected";
  readonly verificationDetail: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
};

const selectBaseline = `
  SELECT baseline_id AS baselineId, sequence, format_version AS formatVersion,
    payload_hash AS payloadHash, verification_status AS verificationStatus,
    verification_detail AS verificationDetail, created_at AS createdAt,
    verified_at AS verifiedAt
  FROM projection_baselines
`;

function validateBaseline(row: BaselineRow): ProjectionBaseline {
  if (row.formatVersion !== PROJECTION_BASELINE_FORMAT_VERSION) {
    throw new Error(`unsupported projection baseline format ${row.formatVersion}`);
  }
  if (Number.isNaN(Date.parse(row.createdAt))) throw new Error("invalid baseline timestamp");
  // The payload hash is checked against the stored rows whenever they are restored.
  if (!/^[0-9a-f]{64}$/.test(row.payloadHash)) throw new Error("invalid baseline payload hash");
  return row;
}

const makeProjectionBaselineRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const captureDigest: ProjectionBaselineRepositoryShape["captureDigest"] = () =>
    sql
      .withTransaction(
        captureBaselineRows(sql, BASELINE_SCRATCH_ID).pipe(
          Effect.tap(() =>
            sql.unsafe("DELETE FROM projection_baseline_rows WHERE baseline_id = ?", [
              BASELINE_SCRATCH_ID,
            ]),
          ),
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.captureDigest")));

  const createCandidate: ProjectionBaselineRepositoryShape["createCandidate"] = (
    requiredProjectors,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Do not compact evidence before bounded historical classification finishes.
          const pending = yield* sql`SELECT 1 FROM projection_threads
            WHERE organization_age_provenance = 'pending' AND organization_revision > 0 LIMIT 1`;
          if (pending.length > 0) return Option.none<ProjectionBaseline>();
          const states = yield* sql.unsafe<{ projector: string; sequence: number }>(
            "SELECT projector, last_applied_sequence AS sequence FROM projection_state ORDER BY projector",
          );
          const required = [...requiredProjectors].toSorted();
          if (
            states.length !== required.length ||
            states.some((state, index) => state.projector !== required[index])
          ) {
            return Option.none<ProjectionBaseline>();
          }
          const sequence = states[0]?.sequence ?? 0;
          if (states.some((state) => state.sequence !== sequence)) {
            return Option.none<ProjectionBaseline>();
          }
          const eventRanges = yield* sql<{ readonly latestSequence: number }>`
            SELECT ${orchestrationSequenceFrontierSql(sql)} AS "latestSequence"
          `;
          if (eventRanges[0]?.latestSequence !== sequence) {
            return Option.none<ProjectionBaseline>();
          }
          const existing = yield* sql.unsafe<BaselineRow>(
            `${selectBaseline} WHERE sequence = ? LIMIT 1`,
            [sequence],
          );
          if (existing[0]) return Option.some(validateBaseline(existing[0]));
          const createdAt = new Date().toISOString();
          const inserted = yield* sql.unsafe<{ readonly baselineId: number }>(
            `INSERT INTO projection_baselines (
              sequence, format_version, payload_json, payload_hash,
              verification_status, verification_detail, created_at, verified_at
            ) VALUES (?, ?, '', '', 'candidate', NULL, ?, NULL)
            RETURNING baseline_id AS baselineId`,
            [sequence, PROJECTION_BASELINE_FORMAT_VERSION, createdAt],
          );
          const baselineId = inserted[0]?.baselineId;
          if (baselineId === undefined) return Option.none<ProjectionBaseline>();
          const payloadHash = yield* captureBaselineRows(sql, baselineId);
          yield* sql.unsafe(
            "UPDATE projection_baselines SET payload_hash = ? WHERE baseline_id = ?",
            [payloadHash, baselineId],
          );
          return Option.some<ProjectionBaseline>({
            baselineId,
            sequence,
            formatVersion: PROJECTION_BASELINE_FORMAT_VERSION,
            payloadHash,
            verificationStatus: "candidate",
            verificationDetail: null,
            createdAt,
            verifiedAt: null,
          });
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.createCandidate")));

  const restorePayload: ProjectionBaselineRepositoryShape["restorePayload"] = (
    source,
    sequence,
    requiredProjectors,
  ) => restoreBaselinePayload(sql, source, sequence, requiredProjectors);

  const payloadSource: ProjectionBaselineRepositoryShape["payloadSource"] = (baseline) =>
    storedBaselinePayloadSource(sql, baseline.baselineId, baseline.payloadHash);

  const getById: ProjectionBaselineRepositoryShape["getById"] = (baselineId) =>
    sql.unsafe<BaselineRow>(`${selectBaseline} WHERE baseline_id = ? LIMIT 1`, [baselineId]).pipe(
      Effect.flatMap((rows) =>
        Effect.try({
          try: () => Option.fromNullishOr(rows[0]).pipe(Option.map(validateBaseline)),
          catch: toPersistenceDecodeCauseError("ProjectionBaselineRepository.getById:validate"),
        }),
      ),
      Effect.mapError((error) =>
        error._tag === "PersistenceDecodeError"
          ? error
          : toPersistenceSqlError("ProjectionBaselineRepository.getById")(error),
      ),
    );

  const latestVerified: ProjectionBaselineRepositoryShape["latestVerified"] = () =>
    sql
      .unsafe<BaselineRow>(
        `${selectBaseline} WHERE verification_status = 'verified' ORDER BY sequence DESC LIMIT 1`,
      )
      .pipe(
        Effect.flatMap((rows) =>
          Effect.try({
            try: () => Option.fromNullishOr(rows[0]).pipe(Option.map(validateBaseline)),
            catch: toPersistenceDecodeCauseError(
              "ProjectionBaselineRepository.latestVerified:validate",
            ),
          }),
        ),
        Effect.mapError((error) =>
          error._tag === "PersistenceDecodeError"
            ? error
            : toPersistenceSqlError("ProjectionBaselineRepository.latestVerified")(error),
        ),
      );

  const markVerified: ProjectionBaselineRepositoryShape["markVerified"] = (
    baselineId,
    sequence,
    verifiedAt,
  ) =>
    sql
      .withTransaction(
        Effect.all(
          [
            sql.unsafe(
              `UPDATE projection_baselines SET verification_status = 'verified',
                verification_detail = NULL, verified_at = ? WHERE baseline_id = ?`,
              [verifiedAt, baselineId],
            ),
            sql.unsafe(
              `UPDATE orchestration_deletion_markers
               SET covered_by_baseline_sequence = ?
               WHERE deletion_sequence <= ?
                 AND (covered_by_baseline_sequence IS NULL OR covered_by_baseline_sequence < ?)`,
              [sequence, sequence, sequence],
            ),
            sql.unsafe(
              `UPDATE orchestration_retention_state
               SET compact_through_sequence = MAX(compact_through_sequence, ?), updated_at = ?
               WHERE singleton_id = 1`,
              [sequence, verifiedAt],
            ),
            sql.unsafe("DELETE FROM projection_baselines WHERE baseline_id <> ? AND sequence < ?", [
              baselineId,
              sequence,
            ]),
            sql.unsafe(`DELETE FROM projection_baseline_rows
              WHERE baseline_id NOT IN (SELECT baseline_id FROM projection_baselines)`),
          ],
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.markVerified")));

  const markRejected: ProjectionBaselineRepositoryShape["markRejected"] = (baselineId, _detail) =>
    sql
      .withTransaction(
        Effect.all(
          [
            sql.unsafe(
              `DELETE FROM projection_baseline_rows WHERE baseline_id = ? AND EXISTS (
                SELECT 1 FROM projection_baselines
                WHERE baseline_id = ? AND verification_status = 'candidate')`,
              [baselineId, baselineId],
            ),
            sql.unsafe(
              "DELETE FROM projection_baselines WHERE baseline_id = ? AND verification_status = 'candidate'",
              [baselineId],
            ),
          ],
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.markRejected")));

  return {
    captureDigest,
    createCandidate,
    getById,
    latestVerified,
    latestVerifiedSequence: makeLatestVerifiedSequence(sql),
    markRejected,
    markVerified,
    payloadSource,
    restorePayload,
  } satisfies ProjectionBaselineRepositoryShape;
});

export const ProjectionBaselineRepositoryLive = Layer.effect(
  ProjectionBaselineRepository,
  makeProjectionBaselineRepository,
);
