import { Effect, Stream, FileSystem, Path, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId, TurnId } from "@bigbud/contracts";
import { LearningReactor } from "../Services/LearningReactor.ts";
import { LearningReactorLive } from "./LearningReactor.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { LearningJobRepository } from "../../persistence/Services/LearningJobs.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { SkillChangeProposalRepository } from "../../persistence/Services/SkillChangeProposals.ts";
import { MemoryStore } from "../../learning/Services/MemoryStore.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";

vi.mock("./LearningReactor.process.ts", () => ({
  makeLearningJobProcessor: Effect.succeed(() => Effect.void),
}));

for (const durable of [false, true]) {
  it(`schedules V2 completion learning only for the explicit durable adapter (${durable})`, async () => {
    const threadId = ThreadId.makeUnsafe("v2-scheduler");
    const turnId = TurnId.makeUnsafe("v2-scheduler-turn");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    const create = vi.fn(() => Effect.void);
    const read = vi.fn(() =>
      Effect.succeed({
        threads: [
          {
            id: threadId,
            modelSelection,
            messages: [{ role: "user", turnId, text: "Synthetic review" }],
          },
        ],
      }),
    );
    const capability = vi.fn(() =>
      Effect.succeed({ sessionModelSwitch: "unsupported", durableLearningReview: durable }),
    );
    const provider = {
      getCapabilities: capability,
      streamEvents: Stream.fromIterable([
        {
          type: "turn.completed",
          provider: "opencodeV2",
          threadId,
          turnId,
          createdAt: "2026-09-30T00:00:00.000Z",
          payload: { state: "completed" },
        },
      ]),
    } as unknown as typeof ProviderService.Service;
    const jobs = {
      hasPending: () => Effect.succeed(false),
      countFinalizedUserMessages: () => Effect.succeed(15),
      getLatestMemoryUserMessageCount: () => Effect.succeed(null),
      createIfAbsent: create,
      recoverInterrupted: () => Effect.succeed([]),
      listQueued: () => Effect.succeed([]),
    } as unknown as typeof LearningJobRepository.Service;
    const engine = {
      getReadModel: read,
      streamDomainEvents: Stream.empty,
    } as unknown as typeof OrchestrationEngineService.Service;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* LearningReactor;
          yield* reactor.start();
          yield* Effect.sleep("50 millis");
          expect(capability).toHaveBeenCalledWith("opencodeV2");
          if (durable)
            expect(create).toHaveBeenCalledWith(
              expect.objectContaining({
                provider: "opencodeV2",
                modelSelection,
                jobId: `learning:${threadId}:${turnId}`,
              }),
            );
          else expect(create).not.toHaveBeenCalled();
        }).pipe(
          Effect.provide(
            LearningReactorLive.pipe(
              Layer.provide(Layer.mergeAll(FileSystem.layerNoop({}), Path.layer)),
            ),
          ),
          Effect.provideService(ProviderService, provider),
          Effect.provideService(OrchestrationEngineService, engine),
          Effect.provideService(LearningJobRepository, jobs),
          Effect.provideService(DiscoveryRegistry, {} as typeof DiscoveryRegistry.Service),
          Effect.provideService(
            SkillChangeProposalRepository,
            {} as typeof SkillChangeProposalRepository.Service,
          ),
          Effect.provideService(MemoryStore, {} as typeof MemoryStore.Service),
          Effect.provideService(ServerConfig, {} as typeof ServerConfig.Service),
          Effect.provideService(
            ProjectionOperationalStateQuery,
            {} as typeof ProjectionOperationalStateQuery.Service,
          ),
        ),
      ),
    );
  });
}
