import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadMetadataGenerationRepositoryLive } from "./ThreadMetadataGeneration.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";
import {
  ThreadMetadataGenerationRepository,
  type MetadataGenerationAttempt,
} from "../Services/ThreadMetadataGeneration.ts";

export const finalWarningLayer = ThreadMetadataGenerationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
export const at = "2026-11-10T10:00:00.000Z";
export const until = "2026-11-10T10:00:30.000Z";
export const seedFinalJob = Effect.fn("seedFinalWarningJob")(function* (
  id: string,
  operation: "title" | "summary" = "title",
) {
  const threadId = yield* seedThread(id);
  const r = yield* ThreadMetadataGenerationRepository;
  const job = yield* r.createOrGet({
    jobId: id,
    threadId,
    operation,
    generationKey: "initial",
    configEpoch: id,
    contextJson: JSON.stringify({
      configuredPrimary: false,
      initialTitle: "Legacy",
      previousMessageCount: 0,
    }),
    expectedRevision: 0,
    sourceFrontier: 1,
    workspaceFingerprint: "workspace",
    createdAt: at,
    nextAttemptAt: at,
    deadlineAt: until,
    modelWaitUntil: until,
    nativeWaitUntil: until,
  });
  return { r, job, threadId };
});
export const seedFinalAttempt = Effect.fn("seedFinalWarningAttempt")(function* (
  jobId: string,
  state: MetadataGenerationAttempt["state"] = "failed",
  stage: MetadataGenerationAttempt["stage"] = "thread-model",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO thread_metadata_generation_attempts (
    attempt_id, job_id, thread_id, stage, ordinal, owner, execution_fingerprint, state,
    payload_json, result, created_at, updated_at
  ) SELECT ${`${jobId}:${stage}`}, job_id, thread_id, ${stage}, 1, 'owner', 'exact-path', ${state},
    '{}', ${state === "result-ready" || state === "completed" ? "Retained result" : null},
    ${at}, ${at} FROM thread_metadata_generation_jobs WHERE job_id = ${jobId}`;
});
export const exhaustFinalJob = Effect.fn("exhaustFinalWarningJob")(function* (
  id: string,
  state: "exhausted" | "unavailable" = "exhausted",
) {
  const r = yield* ThreadMetadataGenerationRepository;
  return yield* r.transitionJob({
    jobId: id,
    expectedRevision: 0,
    state,
    nextAttemptAt: at,
  });
});
