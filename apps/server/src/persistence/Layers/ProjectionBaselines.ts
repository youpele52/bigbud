import { createHash } from "node:crypto";

import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionBaselineRepository,
  type ProjectionBaseline,
  type ProjectionBaselineRepositoryShape,
} from "../Services/ProjectionBaselines.ts";

export const PROJECTION_BASELINE_FORMAT_VERSION = 1;

const TABLES = [
  "projection_projects",
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_thread_tasks",
  "projection_thread_sessions",
  "projection_turns",
  "projection_pending_approvals",
  "projection_pending_user_inputs",
  "projection_usage_contributions",
] as const;

type BaselinePayload = {
  readonly tables: Record<string, ReadonlyArray<Record<string, unknown>>>;
};

type BaselineRow = {
  readonly baselineId: number;
  readonly sequence: number;
  readonly formatVersion: number;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly verificationStatus: "candidate" | "verified" | "rejected";
  readonly verificationDetail: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
};

const selectBaseline = `
  SELECT baseline_id AS baselineId, sequence, format_version AS formatVersion,
    payload_json AS payloadJson, payload_hash AS payloadHash,
    verification_status AS verificationStatus,
    verification_detail AS verificationDetail, created_at AS createdAt,
    verified_at AS verifiedAt
  FROM projection_baselines
`;

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(row)
      .toSorted()
      .map((key) => [key, row[key]]),
  );
}

function compareNormalizedRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function parsePayload(payloadJson: string): BaselinePayload {
  const value: unknown = JSON.parse(payloadJson);
  if (typeof value !== "object" || value === null || !("tables" in value)) {
    throw new Error("baseline payload has no tables object");
  }
  const tables = (value as { tables?: unknown }).tables;
  if (typeof tables !== "object" || tables === null) {
    throw new Error("baseline payload tables are invalid");
  }
  for (const table of TABLES) {
    if (!Array.isArray((tables as Record<string, unknown>)[table])) {
      throw new Error(`baseline payload is missing ${table}`);
    }
  }
  return value as BaselinePayload;
}

function validateBaseline(row: BaselineRow): ProjectionBaseline {
  if (row.formatVersion !== PROJECTION_BASELINE_FORMAT_VERSION) {
    throw new Error(`unsupported projection baseline format ${row.formatVersion}`);
  }
  if (Number.isNaN(Date.parse(row.createdAt))) throw new Error("invalid baseline timestamp");
  const hash = createHash("sha256").update(row.payloadJson).digest("hex");
  if (hash !== row.payloadHash) throw new Error("projection baseline payload hash mismatch");
  parsePayload(row.payloadJson);
  return row;
}

const makeProjectionBaselineRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const capturePayloadUnsafe = Effect.gen(function* () {
    const tables: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
    for (const table of TABLES) {
      const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table}`);
      const baselineRows =
        table === "projection_projects"
          ? rows.filter((row) => row.project_id !== "__chats__")
          : rows;
      tables[table] = baselineRows.map(normalizeRow).toSorted(compareNormalizedRows);
    }
    return JSON.stringify({ tables } satisfies BaselinePayload);
  });

  const capturePayload: ProjectionBaselineRepositoryShape["capturePayload"] = () =>
    capturePayloadUnsafe.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.capturePayload")),
    );

  const createCandidate: ProjectionBaselineRepositoryShape["createCandidate"] = (
    requiredProjectors,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
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
          const eventRanges = yield* sql.unsafe<{ latestSequence: number }>(
            `SELECT MAX(
              (SELECT retained_through_sequence FROM orchestration_retention_state WHERE singleton_id = 1),
              COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0)
            ) AS latestSequence`,
          );
          if (eventRanges[0]?.latestSequence !== sequence) {
            return Option.none<ProjectionBaseline>();
          }
          const payloadJson = yield* capturePayloadUnsafe;
          const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
          const createdAt = new Date().toISOString();
          const existing = yield* sql.unsafe<BaselineRow>(
            `${selectBaseline} WHERE sequence = ? LIMIT 1`,
            [sequence],
          );
          if (existing[0]) return Option.some(validateBaseline(existing[0]));
          const inserted = yield* sql.unsafe<BaselineRow>(
            `INSERT INTO projection_baselines (
              sequence, format_version, payload_json, payload_hash,
              verification_status, verification_detail, created_at, verified_at
            ) VALUES (?, ?, ?, ?, 'candidate', NULL, ?, NULL)
            RETURNING baseline_id AS baselineId, sequence, format_version AS formatVersion,
              payload_json AS payloadJson, payload_hash AS payloadHash,
              verification_status AS verificationStatus,
              verification_detail AS verificationDetail, created_at AS createdAt,
              verified_at AS verifiedAt`,
            [sequence, PROJECTION_BASELINE_FORMAT_VERSION, payloadJson, payloadHash, createdAt],
          );
          return inserted[0] ? Option.some(inserted[0]) : Option.none<ProjectionBaseline>();
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.createCandidate")));

  const restorePayload: ProjectionBaselineRepositoryShape["restorePayload"] = (
    payloadJson,
    sequence,
    requiredProjectors,
  ) =>
    Effect.try({
      try: () => parsePayload(payloadJson),
      catch: toPersistenceDecodeCauseError("ProjectionBaselineRepository.restorePayload:decode"),
    }).pipe(
      Effect.flatMap((payload) =>
        sql.withTransaction(
          Effect.gen(function* () {
            for (const table of TABLES.toReversed()) {
              yield* sql.unsafe(
                table === "projection_projects"
                  ? `DELETE FROM ${table} WHERE project_id <> '__chats__'`
                  : `DELETE FROM ${table}`,
              );
            }
            for (const table of TABLES) {
              const allowedColumns = new Set(
                (yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)).map(
                  (column) => column.name,
                ),
              );
              for (const row of payload.tables[table] ?? []) {
                const columns = Object.keys(row);
                if (columns.length === 0 || columns.some((column) => !allowedColumns.has(column))) {
                  return yield* toPersistenceDecodeCauseError(
                    "ProjectionBaselineRepository.restorePayload:columns",
                  )(new Error(`invalid columns for ${table}`));
                }
                const quoted = columns.map((column) => `"${column}"`).join(", ");
                const placeholders = columns.map(() => "?").join(", ");
                yield* sql.unsafe(
                  `INSERT INTO ${table} (${quoted}) VALUES (${placeholders})`,
                  columns.map((column) => row[column]),
                );
              }
            }
            yield* sql`DELETE FROM projection_state`;
            const updatedAt = new Date().toISOString();
            for (const projector of requiredProjectors) {
              yield* sql`
                INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
                VALUES (${projector}, ${sequence}, ${updatedAt})
              `;
            }
          }),
        ),
      ),
      Effect.mapError((error) =>
        error._tag === "PersistenceDecodeError"
          ? error
          : toPersistenceSqlError("ProjectionBaselineRepository.restorePayload")(error),
      ),
    );

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
          ],
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.markVerified")));

  const markRejected: ProjectionBaselineRepositoryShape["markRejected"] = (baselineId, _detail) =>
    sql
      .unsafe("DELETE FROM projection_baselines WHERE baseline_id = ?", [baselineId])
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProjectionBaselineRepository.markRejected")),
      );

  return {
    capturePayload,
    createCandidate,
    getById,
    latestVerified,
    markRejected,
    markVerified,
    restorePayload,
  } satisfies ProjectionBaselineRepositoryShape;
});

export const ProjectionBaselineRepositoryLive = Layer.effect(
  ProjectionBaselineRepository,
  makeProjectionBaselineRepository,
);
