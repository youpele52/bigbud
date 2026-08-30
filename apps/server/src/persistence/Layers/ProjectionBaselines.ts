import { createHash } from "node:crypto";

import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import { orchestrationSequenceFrontierSql } from "../OrchestrationSequenceFrontier.ts";
import { PROJECTION_BASELINE_TABLES } from "../ProjectionBaselineSchema.ts";
import {
  ProjectionBaselineRepository,
  type ProjectionBaseline,
  type ProjectionBaselineRepositoryShape,
} from "../Services/ProjectionBaselines.ts";

export const PROJECTION_BASELINE_FORMAT_VERSION = 1;

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
  for (const table of PROJECTION_BASELINE_TABLES) {
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
    for (const table of PROJECTION_BASELINE_TABLES) {
      const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table}`);
      const currentThreadIds =
        table === "projection_threads" ? new Set(rows.map((row) => row.thread_id)) : null;
      const baselineRows =
        table === "projection_projects"
          ? rows.filter((row) => row.project_id !== "__chats__")
          : currentThreadIds === null
            ? rows
            : rows.map((row) =>
                row.parent_thread_id === null || currentThreadIds.has(row.parent_thread_id)
                  ? row
                  : Object.assign({}, row, {
                      parent_thread_id: null,
                      parent_thread_title: null,
                      parent_thread_project_id: null,
                    }),
              );
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
          const payloadJson = yield* capturePayloadUnsafe;
          const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
          const createdAt = new Date().toISOString();
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
            const restoredThreadIds = new Set(
              (payload.tables.projection_threads ?? []).map((row) => row.thread_id),
            );
            const activeWatches = yield* sql<{
              readonly watchId: string;
              readonly watcherThreadId: string;
              readonly watchedThreadId: string;
              readonly watchedThreadTitle: string;
              readonly sourceMessageId: string;
              readonly status: string;
              readonly createdAt: string;
              readonly triggeredAt: string | null;
            }>`
              SELECT watch_id AS "watchId", watcher_thread_id AS "watcherThreadId",
                watched_thread_id AS "watchedThreadId", watched_thread_title AS "watchedThreadTitle",
                source_message_id AS "sourceMessageId", status, created_at AS "createdAt",
                triggered_at AS "triggeredAt"
              FROM projection_thread_watches
              WHERE status = 'active'
            `;
            for (const table of PROJECTION_BASELINE_TABLES.toReversed()) {
              yield* sql.unsafe(
                table === "projection_projects"
                  ? `DELETE FROM ${table} WHERE project_id <> '__chats__'`
                  : `DELETE FROM ${table}`,
              );
            }
            for (const table of PROJECTION_BASELINE_TABLES) {
              const allowedColumns = new Set(
                (yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)).map(
                  (column) => column.name,
                ),
              );
              for (const payloadRow of payload.tables[table] ?? []) {
                const row =
                  table === "projection_threads" &&
                  payloadRow.parent_thread_id !== null &&
                  !restoredThreadIds.has(payloadRow.parent_thread_id)
                    ? Object.assign({}, payloadRow, {
                        parent_thread_id: null,
                        parent_thread_title: null,
                        parent_thread_project_id: null,
                      })
                    : payloadRow;
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
            yield* sql`
              UPDATE projection_threads
              SET parent_thread_id = NULL, parent_thread_title = NULL, parent_thread_project_id = NULL
              WHERE parent_thread_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM projection_threads AS parent
                  WHERE parent.thread_id = projection_threads.parent_thread_id
                )
            `;
            yield* sql`DELETE FROM projection_state`;
            const updatedAt = new Date().toISOString();
            for (const projector of requiredProjectors) {
              yield* sql`
                INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
                VALUES (${projector}, ${sequence}, ${updatedAt})
              `;
            }
            for (const watch of activeWatches) {
              yield* sql`
                INSERT INTO projection_thread_watches (
                  watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
                  source_message_id, status, created_at, triggered_at
                )
                SELECT ${watch.watchId}, ${watch.watcherThreadId}, ${watch.watchedThreadId},
                  ${watch.watchedThreadTitle}, ${watch.sourceMessageId}, ${watch.status},
                  ${watch.createdAt}, ${watch.triggeredAt}
                WHERE EXISTS (
                  SELECT 1 FROM projection_threads WHERE thread_id = ${watch.watcherThreadId}
                ) AND EXISTS (
                  SELECT 1 FROM projection_threads WHERE thread_id = ${watch.watchedThreadId}
                )
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
      .unsafe(
        "DELETE FROM projection_baselines WHERE baseline_id = ? AND verification_status = 'candidate'",
        [baselineId],
      )
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
