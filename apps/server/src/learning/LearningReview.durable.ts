import * as Effect from "effect/Effect";
import { LearningReviewOutputError } from "./LearningReview.ts";
import type { LearningMemoryDocuments } from "../persistence/Services/LearningJobs.memory.ts";
import type {
  LearningJob,
  LearningJobRepositoryShape,
} from "../persistence/Services/LearningJobs.ts";
import type { MemoryScope, MemoryStoreShape } from "./Services/MemoryStore.ts";

/** Unconfirmed file writes are reconciled by equality only, never repeated after expiry/restart. */
export function makeDurableMemoryReview(
  job: LearningJob,
  jobs: LearningJobRepositoryShape,
  memory: MemoryStoreShape,
) {
  const snapshot = (documents: LearningMemoryDocuments) =>
    jobs.memorySnapshot({ jobId: job.jobId, attemptCount: job.attemptCount, documents });
  const apply = Effect.fn("LearningReview.applyDurableMemory")(function* (input: {
    scope: MemoryScope;
    document: LearningMemoryDocuments["user"];
    content: string;
  }) {
    const identity = { jobId: job.jobId, scope: input.scope, content: input.content };
    const state = yield* jobs.beginMemoryApplication({
      ...identity,
      attemptCount: job.attemptCount,
    });
    if (state === "completed") return;
    if (state === "conflict")
      return yield* Effect.fail(
        new LearningReviewOutputError("Learning application ownership/result conflict."),
      );
    if (state === "uncertain") {
      const current = yield* memory.read({
        scope: input.scope,
        projectId: input.document.projectId,
      });
      if (current.content !== input.content)
        return yield* Effect.fail(
          new LearningReviewOutputError(
            "Learning application remains unconfirmed; no duplicate write is permitted.",
          ),
        );
    } else
      yield* memory.write({
        scope: input.scope,
        projectId: input.document.projectId,
        content: input.content,
        expectedContent: input.document.content,
      });
    yield* jobs.completeMemoryApplication(identity);
  });
  return { snapshot, apply };
}
