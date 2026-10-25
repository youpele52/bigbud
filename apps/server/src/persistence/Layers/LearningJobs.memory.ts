import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { LearningMemoryDocuments } from "../Services/LearningJobs.memory.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import type { LearningJobRepositoryShape } from "../Services/LearningJobs.ts";

/** Immutable review baselines and one-way receipts survive retries without licensing a second write. */
export function makeLearningMemoryQueries(sql: SqlClient.SqlClient) {
  const memorySnapshot: LearningJobRepositoryShape["memorySnapshot"] = Effect.fn(
    "LearningJobs.memorySnapshot",
  )(function* ({ jobId, attemptCount, documents }) {
    yield* sql`INSERT INTO learning_memory_snapshots (job_id, documents_json)
      SELECT job_id, ${JSON.stringify(documents)} FROM learning_jobs
      WHERE job_id = ${jobId} AND state = 'reviewing' AND attempt_count = ${attemptCount}
      ON CONFLICT(job_id) DO NOTHING`.pipe(
      Effect.mapError(toPersistenceSqlError("learning.memorySnapshot")),
    );
    const rows = yield* sql<{
      json: string;
    }>`SELECT s.documents_json AS json FROM learning_memory_snapshots s
      JOIN learning_jobs j ON j.job_id = s.job_id WHERE s.job_id = ${jobId} AND j.state = 'reviewing' AND j.attempt_count = ${attemptCount}`.pipe(
      Effect.mapError(toPersistenceSqlError("learning.memorySnapshot.read")),
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LearningMemoryDocuments))(
      rows[0]?.json,
    ).pipe(Effect.mapError(toPersistenceDecodeError("learning.memorySnapshot.decode")));
  });
  const beginMemoryApplication: LearningJobRepositoryShape["beginMemoryApplication"] = Effect.fn(
    "LearningJobs.beginMemoryApplication",
  )(function* ({ jobId, attemptCount, scope, content }) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const owner =
            yield* sql`SELECT job_id FROM learning_jobs WHERE job_id = ${jobId} AND state = 'reviewing' AND attempt_count = ${attemptCount}`;
          if (!owner.length) return "conflict" as const;
          const created =
            yield* sql`INSERT INTO learning_memory_applications (job_id, scope, content, state)
        VALUES (${jobId}, ${scope}, ${content}, 'started') ON CONFLICT(job_id, scope) DO NOTHING RETURNING job_id`;
          if (created.length) return "execute" as const;
          const previous = yield* sql<{
            content: string;
            state: string;
          }>`SELECT content, state FROM learning_memory_applications WHERE job_id = ${jobId} AND scope = ${scope}`;
          if (previous[0]?.content !== content) return "conflict" as const;
          return previous[0].state === "completed"
            ? ("completed" as const)
            : ("uncertain" as const);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("learning.beginMemoryApplication")));
  });
  const completeMemoryApplication: LearningJobRepositoryShape["completeMemoryApplication"] =
    Effect.fn("LearningJobs.completeMemoryApplication")(function* ({ jobId, scope, content }) {
      const rows =
        yield* sql`UPDATE learning_memory_applications SET state = 'completed' WHERE job_id = ${jobId} AND scope = ${scope} AND content = ${content} RETURNING job_id`.pipe(
          Effect.mapError(toPersistenceSqlError("learning.completeMemoryApplication")),
        );
      if (!rows.length)
        return yield* Effect.fail(
          toPersistenceSqlError("learning.completeMemoryApplication")(
            new Error("Missing application intent"),
          ),
        );
    });
  return { memorySnapshot, beginMemoryApplication, completeMemoryApplication };
}
