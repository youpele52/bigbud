import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";
import type {
  MetadataThreadModelBinding,
  ThreadMetadataGenerationRepositoryShape,
} from "../Services/ThreadMetadataGeneration.ts";

export const makeMetadataModelBindings = Effect.fn("makeMetadataModelBindings")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readThreadModelBinding: ThreadMetadataGenerationRepositoryShape["readThreadModelBinding"] =
    (jobId) =>
      sql<MetadataThreadModelBinding>`SELECT job_id AS "jobId", path_json AS "pathJson",
        verified_model_json AS "verifiedModelJson", bound_at AS "boundAt"
        FROM thread_metadata_generation_model_bindings WHERE job_id = ${jobId}`.pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
        Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.readThreadModelBinding")),
      );
  const bindThreadModel: ThreadMetadataGenerationRepositoryShape["bindThreadModel"] = (input) =>
    withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        const inserted = yield* sql<{
          jobId: string;
        }>`INSERT INTO thread_metadata_generation_model_bindings
        (job_id, path_json, verified_model_json, bound_at)
        SELECT j.job_id, ${input.pathJson}, ${input.verifiedModelJson}, ${input.at}
        FROM thread_metadata_generation_jobs j
        JOIN thread_metadata_generation_state s ON s.thread_id = j.thread_id
        WHERE j.job_id = ${input.job.jobId} AND j.revision = ${input.job.revision}
          AND j.state IN ('pending', 'waiting-model', 'running')
          AND j.created_at <= ${input.at}
          AND j.deadline_at > ${input.at}
          AND json_type(j.context_json, '$.threadPath') = 'null'
          AND (json_extract(j.context_json, '$.configuredPrimary') = 1
            OR json_type(j.context_json, '$.primaryPath') = 'null')
          AND s.successful_model_json = ${input.verifiedModelJson}
          AND NOT EXISTS (SELECT 1 FROM thread_metadata_generation_attempts a
            WHERE a.job_id = j.job_id AND (a.stage IN ('thread-model', 'native')
              OR a.state IN ('prepared', 'dispatch-intent', 'acknowledged', 'uncertain', 'result-ready')
              OR json_extract(j.context_json, '$.configuredPrimary') = 0))
        ON CONFLICT DO NOTHING RETURNING job_id AS "jobId"`;
        if (inserted.length !== 1) return false;
        // Fence a worker holding the old path-less job revision in the same transaction.
        yield* sql`UPDATE thread_metadata_generation_jobs SET revision = revision + 1
        WHERE job_id = ${input.job.jobId}`;
        return true;
      }),
    ).pipe(Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.bindThreadModel")));
  return { readThreadModelBinding, bindThreadModel };
});
