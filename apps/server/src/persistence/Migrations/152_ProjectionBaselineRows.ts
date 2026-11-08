import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  hashBaselinePayload,
  PROJECTION_BASELINE_FORMAT_VERSION,
  storedBaselinePayloadSource,
} from "../ProjectionBaselineRows.ts";
import { PROJECTION_BASELINE_TABLES } from "../ProjectionBaselineSchema.ts";

/** Bytes of a legacy payload read per statement while checking its hash. */
export const LEGACY_BASELINE_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

const LEGACY_FORMAT_VERSION = 1;

/** sha256 of a legacy payload, read in byte chunks so the string never enters JavaScript. */
const legacyPayloadHash = (sql: SqlClient.SqlClient, baselineId: number, bytes: number) =>
  Effect.gen(function* () {
    const hash = createHash("sha256");
    for (let offset = 1; offset <= bytes; offset += LEGACY_BASELINE_HASH_CHUNK_BYTES) {
      const rows = yield* sql<{ readonly chunk: Uint8Array }>`
        SELECT substr(CAST(payload_json AS BLOB), ${offset}, ${LEGACY_BASELINE_HASH_CHUNK_BYTES})
          AS chunk
        FROM projection_baselines WHERE baseline_id = ${baselineId}
      `;
      hash.update(rows[0]?.chunk ?? new Uint8Array());
    }
    return hash.digest("hex");
  });

/**
 * Moves projection baselines from one JSON string per baseline (format 1) to one row per
 * projection row (format 2). A ~150 MB payload string crashed the backend on every read.
 *
 * Only verified legacy baselines are kept; candidates are recreated on the next compaction.
 * Each is checked against its recorded hash first. The conversion itself runs inside SQLite
 * with `json_each`, and the new hash is computed from the stored rows page by page.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_baseline_rows (
      baseline_id INTEGER NOT NULL,
      table_name TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (baseline_id, table_name, ordinal)
    )
  `;
  yield* sql`
    DELETE FROM projection_baselines
    WHERE format_version = ${LEGACY_FORMAT_VERSION} AND verification_status <> 'verified'
  `;
  const legacy = yield* sql<{
    readonly baselineId: number;
    readonly payloadHash: string;
    readonly bytes: number | null;
    readonly valid: number | null;
  }>`
    SELECT baseline_id AS "baselineId", payload_hash AS "payloadHash",
      length(CAST(payload_json AS BLOB)) AS bytes, json_valid(payload_json) AS valid
    FROM projection_baselines WHERE format_version = ${LEGACY_FORMAT_VERSION}
  `;
  for (const baseline of legacy) {
    const intact =
      baseline.valid === 1 &&
      (yield* legacyPayloadHash(sql, baseline.baselineId, baseline.bytes ?? 0)) ===
        baseline.payloadHash;
    if (!intact) {
      yield* Effect.logWarning("dropping corrupt legacy projection baseline", {
        baselineId: baseline.baselineId,
      });
      yield* sql`DELETE FROM projection_baselines WHERE baseline_id = ${baseline.baselineId}`;
      continue;
    }
    yield* sql`DELETE FROM projection_baseline_rows WHERE baseline_id = ${baseline.baselineId}`;
    yield* sql`
      INSERT INTO projection_baseline_rows (baseline_id, table_name, ordinal, row_json)
      SELECT baseline.baseline_id, payload_table.key, payload_row.key, payload_row.value
      FROM projection_baselines AS baseline,
        json_each(baseline.payload_json, '$.tables') AS payload_table,
        json_each(payload_table.value) AS payload_row
      WHERE baseline.baseline_id = ${baseline.baselineId}
        AND payload_table.key IN ${sql.in(PROJECTION_BASELINE_TABLES)}
    `;
    const payloadHash = yield* hashBaselinePayload(
      storedBaselinePayloadSource(sql, baseline.baselineId, null),
    );
    yield* sql`
      UPDATE projection_baselines
      SET format_version = ${PROJECTION_BASELINE_FORMAT_VERSION}, payload_json = '',
        payload_hash = ${payloadHash}
      WHERE baseline_id = ${baseline.baselineId}
    `;
  }
});
