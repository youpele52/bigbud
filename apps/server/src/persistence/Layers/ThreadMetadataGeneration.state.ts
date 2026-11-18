import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type {
  ThreadMetadataGenerationRepositoryShape,
  ThreadMetadataState,
} from "../Services/ThreadMetadataGeneration.ts";
import { scanLegacyMetadataSuccessfulModel } from "./ThreadMetadataGeneration.legacy.admission.ts";
import { makeLegacyMetadataEvidenceReader } from "./ThreadMetadataGeneration.legacy.ts";
import { withMetadataTransaction } from "./ThreadMetadataGeneration.transaction.ts";

/** Shared by capture, late binding, and freshness. Only a cold NULL selection scans
 * history; a recovered or newly recorded success uses the ordinary indexed state read.
 * Callers retain their history barrier. SQL snapshot + NULL-only CAS prevents an
 * upgrade bootstrap from replacing newer canonical evidence or changing any budget.
 */
export const makeMetadataStateReader = Effect.fn("makeMetadataStateReader")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readLegacy = yield* makeLegacyMetadataEvidenceReader();
  const raw: ThreadMetadataGenerationRepositoryShape["readMetadataState"] = (threadId) =>
    sql<ThreadMetadataState>`SELECT title_revision AS "titleRevision", summary_revision AS "summaryRevision",
      summary_attempted_frontier AS "summaryAttemptedFrontier", successful_model_json AS "successfulModelJson"
      FROM thread_metadata_generation_state WHERE thread_id = ${threadId}`.pipe(
      Effect.map(
        (rows) =>
          rows[0] ?? {
            titleRevision: 0,
            summaryRevision: 0,
            summaryAttemptedFrontier: 0,
            successfulModelJson: null,
          },
      ),
      Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.readMetadataState")),
    );
  const read = Effect.fn("metadataState.read")(function* (threadId: Parameters<typeof raw>[0]) {
    const initial = yield* raw(threadId);
    if (initial.successfulModelJson !== null) return initial;
    return yield* withMetadataTransaction(
      sql,
      Effect.gen(function* () {
        const current = yield* raw(threadId);
        if (current.successfulModelJson !== null) return current;
        const legacy = yield* scanLegacyMetadataSuccessfulModel(readLegacy, threadId);
        if (!legacy.allowed || !legacy.successfulModel) return current;
        const modelJson = JSON.stringify(legacy.successfulModel);
        yield* sql`INSERT INTO thread_metadata_generation_state (thread_id, successful_model_json)
          VALUES (${threadId}, ${modelJson}) ON CONFLICT(thread_id) DO UPDATE
          SET successful_model_json = excluded.successful_model_json
          WHERE thread_metadata_generation_state.successful_model_json IS NULL`;
        return yield* raw(threadId);
      }),
    );
  });
  return (threadId: Parameters<typeof read>[0]) =>
    read(threadId).pipe(
      // Include the initial state read and connection acquisition in the deadline.
      // A timed-out read cannot supply freshness revisions or a verified selection.
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () =>
          Effect.fail(new Error("Metadata successful-model recovery deadline exceeded.")),
      }),
      Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.bootstrapSuccessfulModel")),
    );
});
