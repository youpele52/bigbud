import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";
import { LearningJobRepository } from "../../persistence/Services/LearningJobs.ts";
import { LearningJobRepositoryLive } from "../../persistence/Layers/LearningJobs.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import {
  MemoryStore,
  type MemoryStoreShape,
  type MemoryScope,
} from "../../learning/Services/MemoryStore.ts";
import { makeLearningJobProcessor } from "./LearningReactor.process.ts";
import { processorFixture } from "./LearningReactor.process.test.helpers.ts";

vi.mock("./LearningReactor.skill.ts", () => ({
  makeResolveSkillContext: () => () => Effect.succeed(null),
}));

it("reconstructs the processor after interruption between memory scopes without reapplying completed writes", async () => {
  const layer = LearningJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00.000Z"));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* LearningJobRepository;
          const sql = yield* SqlClient.SqlClient;
          const f = processorFixture();
          Object.assign(f.job, {
            provider: "opencodeV2",
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic",
              model: "test-model",
            },
            state: "queued",
            attemptCount: 0,
          });
          Object.assign(f.thread, { modelSelection: f.job.modelSelection });
          yield* insertProjectionThreadParent({ sql, threadId: f.job.threadId });
          yield* jobs.createIfAbsent(f.job);
          f.getCapabilities.mockImplementation(() =>
            Effect.succeed({ sessionModelSwitch: "unsupported", durableLearningReview: true }),
          );
          const contents = new Map<MemoryScope, string>();
          const written: MemoryScope[] = [];
          let hold = true;
          let entered!: () => void;
          const blocked = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const output = JSON.stringify({
            userMemory: "New preference.",
            globalMemory: "Global fact.",
            projectMemory: "Project fact.",
            skillPatch: null,
          });
          f.runBackgroundReview.mockImplementation(() =>
            Effect.gen(function* () {
              expect(
                (yield* sql`SELECT lease_id FROM thread_activity_leases WHERE lease_id = ${`learning:${f.job.jobId}`}`.pipe(
                  Effect.orDie,
                )).length,
              ).toBe(1);
              return output; // Same durably cached native result; this fixture does not generate twice.
            }),
          );
          const memory: MemoryStoreShape = {
            read: (input) =>
              Effect.succeed({
                ...input,
                content: contents.get(input.scope) ?? "",
                updatedAt: new Date().toISOString(),
              }),
            write: (input) =>
              Effect.gen(function* () {
                expect(contents.get(input.scope) ?? "").toBe(input.expectedContent);
                contents.set(input.scope, input.content);
                written.push(input.scope);
                return { ...input, updatedAt: new Date().toISOString() };
              }),
          };
          const dependencies = Layer.mergeAll(
            f.layer,
            Layer.succeed(LearningJobRepository, {
              ...jobs,
              getReviewMessages: f.getReviewMessages,
              beginMemoryApplication: (input) =>
                input.scope === "global" && hold
                  ? Effect.sync(entered).pipe(Effect.andThen(Effect.never))
                  : jobs.beginMemoryApplication(input),
            }),
            Layer.succeed(MemoryStore, memory),
          );
          const firstProcessor = yield* makeLearningJobProcessor.pipe(Effect.provide(dependencies));
          const first = Effect.runFork(firstProcessor(f.job));
          yield* Effect.promise(() => blocked);
          expect(written).toEqual(["user"]);
          yield* Fiber.interrupt(first);
          contents.set("user", "manual edit after completed user write\n");
          hold = false;
          vi.setSystemTime(new Date("2026-09-30T10:01:00.000Z"));
          yield* jobs.recoverInterrupted({ now: new Date().toISOString() });
          const secondProcessor = yield* makeLearningJobProcessor.pipe(
            Effect.provide(dependencies),
          );
          yield* secondProcessor(f.job);
          expect(written).toEqual(["user", "global", "project"]);
          expect(contents.get("user")).toBe("manual edit after completed user write\n");
          expect(contents.get("global")).toBe("Global fact.\n");
          expect(contents.get("project")).toBe("Project fact.\n");
          expect(f.runBackgroundReview).toHaveBeenCalledTimes(2);
          expect(f.runBackgroundReview.mock.calls[1]?.[0].input).toContain(
            "CURRENT USER.md:\n(empty)",
          );
          expect(
            (yield* sql<{
              state: string;
            }>`SELECT state FROM learning_jobs WHERE job_id = ${f.job.jobId}`)[0]?.state,
          ).toBe("completed");
          expect(
            yield* sql`SELECT scope, state FROM learning_memory_applications WHERE job_id = ${f.job.jobId} ORDER BY scope`,
          ).toEqual([
            { scope: "global", state: "completed" },
            { scope: "project", state: "completed" },
            { scope: "user", state: "completed" },
          ]);
        }),
      ).pipe(Effect.provide(layer)),
    );
  } finally {
    vi.useRealTimers();
  }
});
