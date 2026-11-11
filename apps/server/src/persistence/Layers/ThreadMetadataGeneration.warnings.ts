import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { makeMetadataFinalWarnings } from "./ThreadMetadataGeneration.finalWarnings.ts";
import type { ThreadMetadataGenerationRepositoryShape } from "../Services/ThreadMetadataGeneration.ts";
import type { MetadataGenerationWarning } from "@bigbud/contracts/orchestration/orchestration.metadataGeneration.ts";

export const makeMetadataWarnings = Effect.fn("makeMetadataWarnings")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { enqueueFinalWarning, deliverable } = makeMetadataFinalWarnings(sql);
  const columns = sql`warning_id AS id, config_epoch AS "configEpoch", thread_id AS "threadId",
    operation, created_at AS "createdAt", primary_failures AS "primaryFailures",
    CASE WHEN warning_id LIKE 'metadata-final-warning:%' THEN 'final' ELSE 'settings' END AS kind`;
  const fail = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`ThreadMetadataGeneration.${operation}`));
  const enqueueWarning: ThreadMetadataGenerationRepositoryShape["enqueueWarning"] = (input) =>
    sql<{ id: string }>`INSERT INTO thread_metadata_generation_warnings (
      warning_id, config_epoch, thread_id, operation, created_at, primary_failures
    ) SELECT ${input.warningId}, j.config_epoch, j.thread_id, j.operation, ${input.at},
        (SELECT COUNT(*) FROM thread_metadata_generation_attempts a
          WHERE a.job_id = j.job_id AND a.stage = 'primary' AND a.state = 'failed')
      FROM thread_metadata_generation_jobs j WHERE j.job_id = ${input.jobId}
        AND json_extract(j.context_json, '$.configuredPrimary') = 1
        AND (json_type(j.context_json, '$.primaryPath') = 'null'
          OR EXISTS (SELECT 1 FROM thread_metadata_generation_attempts a
            WHERE a.job_id = j.job_id AND a.stage = 'primary' AND a.state = 'unavailable')
          OR (SELECT COUNT(*) FROM thread_metadata_generation_attempts a
            WHERE a.job_id = j.job_id AND a.stage = 'primary' AND a.state = 'failed') >= 2)
      ON CONFLICT DO NOTHING RETURNING warning_id AS id`.pipe(
      Effect.map((rows) => rows.length === 1),
      fail("enqueueWarning"),
    );
  const listPendingWarnings: ThreadMetadataGenerationRepositoryShape["listPendingWarnings"] = (
    limit,
  ) =>
    sql<MetadataGenerationWarning>`SELECT ${columns}
      FROM thread_metadata_generation_warnings WHERE acknowledged_at IS NULL AND ${deliverable}
      ORDER BY created_at, warning_id LIMIT ${Math.max(1, Math.min(100, limit))}`.pipe(
      fail("listPendingWarnings"),
    );
  const claimPendingWarnings: ThreadMetadataGenerationRepositoryShape["claimPendingWarnings"] = (
    input,
  ) =>
    sql<MetadataGenerationWarning>`UPDATE thread_metadata_generation_warnings
      SET claimed_by = ${input.clientId}, claim_until = ${input.until}
      WHERE ${input.until} > ${input.at} AND warning_id IN (
        SELECT warning_id FROM thread_metadata_generation_warnings
        WHERE acknowledged_at IS NULL AND ${deliverable}
          AND (claimed_by IS NULL OR claim_until <= ${input.at} OR claimed_by = ${input.clientId})
        ORDER BY created_at, warning_id LIMIT 10
      ) RETURNING ${columns}`.pipe(fail("claimPendingWarnings"));
  const claimWarning: ThreadMetadataGenerationRepositoryShape["claimWarning"] = (input) =>
    sql<{ id: string }>`UPDATE thread_metadata_generation_warnings
      SET claimed_by = ${input.clientId}, claim_until = ${input.until}
      WHERE warning_id = ${input.warningId} AND acknowledged_at IS NULL AND ${deliverable}
        AND ${input.until} > ${input.at}
        AND (claimed_by IS NULL OR claim_until <= ${input.at} OR claimed_by = ${input.clientId})
      RETURNING warning_id AS id`.pipe(
      Effect.map((rows) => rows.length === 1),
      fail("claimWarning"),
    );
  const acknowledgeWarning: ThreadMetadataGenerationRepositoryShape["acknowledgeWarning"] = (
    input,
  ) =>
    sql<{ id: string }>`UPDATE thread_metadata_generation_warnings SET acknowledged_at = ${input.at}
      WHERE warning_id = ${input.warningId} AND claimed_by = ${input.clientId}
        AND acknowledged_at IS NULL AND claim_until > ${input.at}
      RETURNING warning_id AS id`.pipe(
      Effect.map((rows) => rows.length === 1),
      fail("acknowledgeWarning"),
    );
  return {
    enqueueWarning,
    enqueueFinalWarning,
    listPendingWarnings,
    claimPendingWarnings,
    claimWarning,
    acknowledgeWarning,
  };
});
