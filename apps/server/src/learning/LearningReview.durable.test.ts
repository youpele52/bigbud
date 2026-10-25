import { ProjectId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LearningJobRepository } from "../persistence/Services/LearningJobs.ts";
import { LearningJobRepositoryLive } from "../persistence/Layers/LearningJobs.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../persistence/Layers/ProjectionThread.test.helpers.ts";
import { makeDurableMemoryReview } from "./LearningReview.durable.ts";
import type { LearningMemoryDocuments } from "../persistence/Services/LearningJobs.memory.ts";
import type { MemoryStoreShape } from "./Services/MemoryStore.ts";

const now = "2026-09-30T00:00:00.000Z";
const documents: LearningMemoryDocuments = {
  user: { scope: "user", projectId: null, content: "baseline\n", updatedAt: now },
  global: { scope: "global", projectId: null, content: "", updatedAt: now },
  project: {
    scope: "project",
    projectId: ProjectId.makeUnsafe("durable-project"),
    content: "",
    updatedAt: now,
  },
};
const layer = LearningJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const setup = Effect.fn("durableLearningTest.setup")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* LearningJobRepository;
  const threadId = ThreadId.makeUnsafe(id);
  yield* insertProjectionThreadParent({ sql, threadId });
  yield* jobs.createIfAbsent({
    jobId: id,
    threadId,
    turnId: TurnId.makeUnsafe(id),
    provider: "opencodeV2",
    model: "synthetic-model",
    modelSelection: {
      provider: "opencodeV2",
      model: "synthetic-model",
      subProviderID: "synthetic-provider",
    },
    memoryUserMessageCount: 15,
    state: "queued",
    createdAt: now,
    updatedAt: now,
  });
  const job = (yield* jobs.claim({ jobId: id, now }))!;
  let content = documents.user.content;
  let writes = 0;
  const memory: MemoryStoreShape = {
    read: (input) => Effect.succeed({ ...input, content, updatedAt: now }),
    write: (input) =>
      Effect.sync(() => {
        writes++;
        content = input.content;
        return { ...input, updatedAt: now };
      }),
  };
  const review = makeDurableMemoryReview(job, jobs, memory);
  return {
    sql,
    jobs,
    job,
    memory,
    review,
    setContent: (text: string) => {
      content = text;
    },
    writes: () => writes,
  };
});

it.layer(layer)("durable memory result application", (it) => {
  it.effect(
    "keeps immutable review baselines and skips completed writes even after manual edits and restart",
    () =>
      Effect.gen(function* () {
        const f = yield* setup("completed-application");
        assert.deepEqual(yield* f.review.snapshot(documents), documents);
        yield* f.review.apply({
          scope: "user",
          document: documents.user,
          content: "replacement\n",
        });
        f.setContent("manual edit after learning\n");
        yield* f.jobs.recoverInterrupted({ now });
        const next = (yield* f.jobs.claim({ jobId: f.job.jobId, now }))!;
        const restarted = makeDurableMemoryReview(next, f.jobs, f.memory);
        assert.deepEqual(
          yield* restarted.snapshot({
            ...documents,
            user: { ...documents.user, content: "manual edit after learning\n" },
          }),
          documents,
        );
        yield* restarted.apply({
          scope: "user",
          document: documents.user,
          content: "replacement\n",
        });
        assert.strictEqual(f.writes(), 1);
        assert.strictEqual(
          yield* f.jobs.beginMemoryApplication({
            jobId: next.jobId,
            attemptCount: f.job.attemptCount,
            scope: "user",
            content: "replacement\n",
          }),
          "conflict",
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              restarted.apply({
                scope: "user",
                document: documents.user,
                content: "different result\n",
              }),
            ),
          ),
        );
      }),
  );
  it.effect(
    "reconciles a crash after rename without another write; a crash before rename fails closed",
    () =>
      Effect.gen(function* () {
        for (const wrote of [true, false]) {
          const f = yield* setup(`uncertain-${wrote}`);
          yield* f.review.snapshot(documents);
          const identity = {
            jobId: f.job.jobId,
            scope: "user" as const,
            content: "replacement\n",
            attemptCount: f.job.attemptCount,
          };
          assert.strictEqual(yield* f.jobs.beginMemoryApplication(identity), "execute");
          f.setContent(wrote ? "replacement\n" : documents.user.content);
          yield* f.jobs.recoverInterrupted({ now });
          const next = (yield* f.jobs.claim({ jobId: f.job.jobId, now }))!;
          const restarted = makeDurableMemoryReview(next, f.jobs, f.memory);
          const exit = yield* Effect.exit(
            restarted.apply({ scope: "user", document: documents.user, content: "replacement\n" }),
          );
          assert.strictEqual(Exit.isSuccess(exit), wrote);
          assert.strictEqual(f.writes(), 0);
          assert.strictEqual(
            yield* f.jobs.beginMemoryApplication({ ...identity, attemptCount: next.attemptCount }),
            wrote ? "completed" : "uncertain",
          );
        }
      }),
  );
  it.effect("does not license applications once the job is no longer reviewing", () =>
    Effect.gen(function* () {
      const f = yield* setup("stale-job");
      yield* f.jobs.setState({ jobId: f.job.jobId, state: "failed", updatedAt: now });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(f.review.snapshot(documents))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            f.review.apply({ scope: "user", document: documents.user, content: "replacement\n" }),
          ),
        ),
      );
      assert.strictEqual(f.writes(), 0);
    }),
  );
});
