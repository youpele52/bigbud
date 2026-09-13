import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect, Layer, Option } from "effect";
import { vi } from "vitest";
import { MemoryStore, type MemoryStoreShape } from "../../learning/Services/MemoryStore.ts";
import {
  LearningJobRepository,
  type LearningJob,
  type LearningJobRepositoryShape,
} from "../../persistence/Services/LearningJobs.ts";
import {
  SkillChangeProposalRepository,
  type SkillChangeProposalRepositoryShape,
} from "../../persistence/Services/SkillChangeProposals.ts";
import {
  DiscoveryRegistry,
  type DiscoveryRegistryShape,
} from "../../provider/Services/DiscoveryRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerConfig, type ServerConfigShape } from "../../startup/config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionOperationalStateQuery,
  type ProjectionOperationalStateQueryShape,
} from "../Services/ProjectionOperationalStateQuery.ts";
import { makeLearningJobProcessor } from "./LearningReactor.process.ts";

export function processorFixture(attemptCount = 1) {
  const now = "2026-09-13T12:00:00.000Z";
  const job: LearningJob = {
    jobId: "learning:processor",
    threadId: ThreadId.makeUnsafe("thread-processor"),
    turnId: TurnId.makeUnsafe("turn-processor"),
    provider: "codex",
    model: "test-model",
    modelSelection: { provider: "codex", model: "test-model" },
    memoryUserMessageCount: 15,
    attemptCount,
    nextAttemptAt: null,
    outcome: null,
    state: "reviewing",
    createdAt: now,
    updatedAt: now,
  };
  const operations: string[] = [];
  let leased = false;
  const thread = {
    id: job.threadId,
    projectId: ProjectId.makeUnsafe("project-processor"),
    worktreePath: null,
    deletedAt: null,
    deletingAt: null,
    messages: [],
    modelSelection: job.modelSelection,
  } as unknown as OrchestrationThread;
  const message = {
    id: MessageId.makeUnsafe("message-processor"),
    turnId: job.turnId,
    role: "user" as const,
    text: "Persisted durable preference",
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  const claim = vi.fn<LearningJobRepositoryShape["claim"]>(() =>
    Effect.sync(() => {
      operations.push("claim");
      return job;
    }),
  );
  const acquireLease = vi.fn<LearningJobRepositoryShape["acquireLease"]>(() =>
    Effect.sync(() => {
      operations.push("acquire");
      leased = true;
      return true;
    }),
  );
  const releaseLease = vi.fn<LearningJobRepositoryShape["releaseLease"]>(() =>
    Effect.sync(() => {
      operations.push("release");
      leased = false;
    }),
  );
  const getReviewMessages = vi.fn<LearningJobRepositoryShape["getReviewMessages"]>(() =>
    Effect.succeed([message]),
  );
  const setState = vi.fn<LearningJobRepositoryShape["setState"]>(() => Effect.void);
  const dispatch = vi.fn(() => Effect.void);
  const getReadModel = vi.fn(() => Effect.die("must not load the cold engine"));
  const getThreadOperationalState = vi.fn<
    ProjectionOperationalStateQueryShape["getThreadOperationalState"]
  >(() => Effect.succeed(Option.some({ threads: [thread], projects: [] } as never)));
  const runBackgroundReview = vi.fn<ProviderServiceShape["runBackgroundReview"]>(() =>
    Effect.sync(() => {
      if (!leased) throw new Error("review outside owner lease");
      operations.push("review");
      return JSON.stringify({
        userMemory: "New preference.",
        globalMemory: null,
        projectMemory: null,
        skillPatch: null,
      });
    }),
  );
  const write = vi.fn<MemoryStoreShape["write"]>((input) =>
    Effect.sync(() => {
      if (!leased) throw new Error("write outside owner lease");
      operations.push("write");
      return { ...input, updatedAt: now };
    }),
  );
  const proposals = {
    getById: vi.fn<SkillChangeProposalRepositoryShape["getById"]>(() =>
      Effect.succeed(Option.none()),
    ),
    create: vi.fn<SkillChangeProposalRepositoryShape["create"]>(() => Effect.void),
    resolve: () => Effect.void,
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(LearningJobRepository, {
      claim,
      acquireLease,
      releaseLease,
      getReviewMessages,
      setState,
    } as unknown as LearningJobRepositoryShape),
    Layer.succeed(ProviderService, { runBackgroundReview } as unknown as ProviderServiceShape),
    Layer.succeed(MemoryStore, {
      read: (input) => Effect.succeed({ ...input, content: "", updatedAt: now }),
      write,
    }),
    Layer.succeed(ServerConfig, { cwd: "/tmp" } as ServerConfigShape),
    Layer.succeed(DiscoveryRegistry, {
      getCatalog: Effect.succeed({ skills: [] }),
    } as unknown as DiscoveryRegistryShape),
    Layer.succeed(SkillChangeProposalRepository, proposals),
    Layer.succeed(OrchestrationEngineService, {
      dispatch,
      getReadModel,
    } as unknown as OrchestrationEngineShape),
    Layer.succeed(ProjectionOperationalStateQuery, {
      getThreadOperationalState,
    } as unknown as ProjectionOperationalStateQueryShape),
  );
  const run = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const process = yield* makeLearningJobProcessor;
        yield* process(job);
      }).pipe(Effect.provide(layer)),
    );
  return {
    job,
    thread,
    operations,
    claim,
    acquireLease,
    releaseLease,
    getReviewMessages,
    setState,
    dispatch,
    getReadModel,
    getThreadOperationalState,
    runBackgroundReview,
    write,
    proposals,
    run,
  };
}
