import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROJECTION_BASELINE_TABLES } from "../ProjectionBaselineSchema.ts";
import {
  BASELINE_SCRATCH_ID,
  forEachBaselinePayloadPage,
  PROJECTION_BASELINE_FORMAT_VERSION,
  storedBaselinePayloadSource,
} from "../ProjectionBaselineRows.ts";
import type {
  BaselinePayloadSource,
  ProjectionBaselineStatus,
} from "../Services/ProjectionBaselines.ts";
import { captureBaselineRows } from "./ProjectionBaselines.capture.ts";

/** Test-only: the whole payload document as one string, the way format 1 stored it. */
export const materializeBaselinePayloadJson = (source: BaselinePayloadSource) =>
  Effect.gen(function* () {
    const tables: Array<string> = [];
    for (const table of PROJECTION_BASELINE_TABLES) {
      const rows: Array<string> = [];
      yield* forEachBaselinePayloadPage(source, table, (page) =>
        Effect.sync(() => page.forEach((row) => rows.push(row.rowJson))),
      );
      tables.push(`${JSON.stringify(table)}:[${rows.join(",")}]`);
    }
    return `{"tables":{${tables.join(",")}}}`;
  });

/** Test-only: captures the current projections and returns them as one JSON payload. */
export const captureBaselinePayloadJson = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* captureBaselineRows(sql, BASELINE_SCRATCH_ID);
  const payloadJson = yield* materializeBaselinePayloadJson(
    storedBaselinePayloadSource(sql, BASELINE_SCRATCH_ID, null),
  );
  yield* sql`DELETE FROM projection_baseline_rows WHERE baseline_id = ${BASELINE_SCRATCH_ID}`;
  return payloadJson;
});

/** Test-only: serves a hand-built JSON payload page by page, without an integrity hash. */
export function jsonBaselinePayloadSource(
  payloadJson: string,
  payloadHash: string | null = null,
): BaselinePayloadSource {
  const parsed = JSON.parse(payloadJson) as {
    readonly tables: Record<string, ReadonlyArray<unknown> | undefined>;
  };
  return {
    payloadHash,
    readTablePage: (table, afterOrdinal, limit) =>
      Effect.succeed(
        (parsed.tables[table] ?? [])
          .map((row, ordinal) => ({ ordinal, rowJson: JSON.stringify(row) }))
          .filter((row) => row.ordinal > afterOrdinal)
          .slice(0, limit),
      ),
  };
}

/** Test-only: stores the current projections as a baseline row set and returns its id. */
export const insertCapturedBaseline = (input: {
  readonly sequence: number;
  readonly status: ProjectionBaselineStatus;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inserted = yield* sql<{ readonly baselineId: number }>`
      INSERT INTO projection_baselines (
        sequence, format_version, payload_json, payload_hash,
        verification_status, verification_detail, created_at, verified_at
      ) VALUES (${input.sequence}, ${PROJECTION_BASELINE_FORMAT_VERSION}, '', '',
        ${input.status}, NULL, ${input.createdAt}, NULL)
      RETURNING baseline_id AS "baselineId"
    `;
    const baselineId = inserted[0]!.baselineId;
    const payloadHash = yield* captureBaselineRows(sql, baselineId);
    yield* sql`UPDATE projection_baselines SET payload_hash = ${payloadHash}
      WHERE baseline_id = ${baselineId}`;
    return { baselineId, payloadHash };
  });
