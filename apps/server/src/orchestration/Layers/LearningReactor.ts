import { CommandId, EventId } from "@bigbud/contracts";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { Effect, FileSystem, Layer, Stream } from "effect";

import { applyValidatedSkillPatch } from "../../learning/LearningValidation.ts";
import { resolveSkillMutationPolicy } from "../../learning/SkillMutationPolicy.ts";
import { LearningJobRepository } from "../../persistence/Services/LearningJobs.ts";
import type { LearningJob } from "../../persistence/Services/LearningJobs.ts";
import { SkillChangeProposalRepository } from "../../persistence/Services/SkillChangeProposals.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { supportsProviderWorkload } from "../../provider/providerWorkloadSupport.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { LearningReactor, type LearningReactorShape } from "../Services/LearningReactor.ts";
import { makeLearningJobProcessor } from "./LearningReactor.process.ts";
import * as LearningReactorLogic from "./LearningReactor.logic.ts";
import { makeLearningActivityPublisher } from "./LearningReactor.activities.ts";
import { resolveSkillName } from "./LearningReactor.skill.ts";

const makeLearningReactor = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const learningJobs = yield* LearningJobRepository;
  const discovery = yield* DiscoveryRegistry;
  const proposals = yield* SkillChangeProposalRepository;
  const fs = yield* FileSystem.FileSystem;
  const turnModels = new Map<string, string>();
  const processJob = yield* makeLearningJobProcessor;
  const activityPublisher = makeLearningActivityPublisher(orchestrationEngine);

  const start: LearningReactorShape["start"] = Effect.fn("startLearningReactor")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        const turnId = event.turnId;
        if (!turnId) return Effect.void;

        const key = `${event.threadId}:${turnId}`;
        if (event.type === "turn.started") {
          if (event.payload.model) turnModels.set(key, event.payload.model);
          return Effect.void;
        }
        if (event.type === "model.rerouted") {
          turnModels.set(key, event.payload.toModel);
          return Effect.void;
        }
        if (event.type !== "turn.completed") {
          if (event.type === "turn.aborted" || event.type === "session.exited")
            turnModels.delete(key);
          return Effect.void;
        }
        if (event.payload.state !== "completed") {
          turnModels.delete(key);
          return Effect.void;
        }

        return Effect.gen(function* () {
          const readModel = yield* orchestrationEngine.getReadModel();
          const thread = readModel.threads.find((entry) => entry.id === event.threadId);
          const model = turnModels.get(key) ?? thread?.modelSelection.model;
          turnModels.delete(key);
          if (!thread || !model) return;
          const sourceUserMessage = thread.messages.find(
            (message) => message.turnId === turnId && message.role === "user",
          )?.text;
          const pending = yield* learningJobs.hasPending({ threadId: thread.id });
          const userMessageCount = yield* learningJobs.countFinalizedUserMessages({
            threadId: thread.id,
          });
          const latestMemoryUserMessageCount = yield* learningJobs.getLatestMemoryUserMessageCount({
            threadId: thread.id,
          });
          const memoryUserMessageCount = LearningReactorLogic.shouldScheduleMemoryReview({
            pending,
            userMessageCount,
            latestMemoryUserMessageCount,
          })
            ? userMessageCount
            : null;
          if (memoryUserMessageCount === null && !sourceUserMessage?.trim()) return;
          if (memoryUserMessageCount === null && !resolveSkillName(sourceUserMessage ?? "")) return;
          if (!supportsProviderWorkload(event.provider, "learning")) return;

          const job = {
            jobId: `learning:${event.threadId}:${event.turnId}`,
            threadId: event.threadId,
            turnId,
            provider: event.provider,
            model,
            modelSelection: LearningReactorLogic.resolveLearningModelSelection({
              provider: event.provider,
              model,
              selected: thread.modelSelection,
            }),
            memoryUserMessageCount,
            state: "queued",
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
            attemptCount: 0,
            nextAttemptAt: null,
            outcome: null,
          } satisfies LearningJob;
          yield* learningJobs.createIfAbsent(job);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("learning job creation failed", {
              threadId: event.threadId,
              turnId: event.turnId,
              cause: cause.toString(),
            }),
          ),
        );
      }),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.approval-response-requested") return Effect.void;
        const prefix = "learning-skill:";
        if (!event.payload.requestId.startsWith(prefix)) return Effect.void;
        const proposalId = event.payload.requestId.slice(prefix.length);
        return Effect.gen(function* () {
          const proposal = yield* proposals.getById(proposalId);
          if (proposal._tag === "None" || proposal.value.status !== "pending") return;
          const resolvedAt = event.payload.createdAt;
          if (event.payload.decision !== "accept") {
            yield* proposals.resolve({ proposalId, status: "rejected", resolvedAt });
          } else {
            const catalog = yield* discovery.refresh(proposal.value.provider);
            const discovered = catalog.skills.find(
              (skill) =>
                skill.provider === proposal.value.provider &&
                skill.sourcePath === proposal.value.skillPath &&
                resolveSkillMutationPolicy(skill) === "approval-required",
            );
            const pathState = yield* Effect.result(
              Effect.tryPromise(async () => ({
                fileStat: await lstat(proposal.value.skillPath),
                proposalRealPath: await realpath(proposal.value.skillPath),
                discoveredRealPath: discovered?.sourcePath
                  ? await realpath(discovered.sourcePath)
                  : null,
              })),
            );
            if (
              !discovered ||
              pathState._tag === "Failure" ||
              pathState.success.fileStat.isSymbolicLink() ||
              pathState.success.discoveredRealPath !== pathState.success.proposalRealPath
            ) {
              yield* proposals.resolve({ proposalId, status: "stale", resolvedAt });
            } else {
              const current = yield* fs
                .readFileString(proposal.value.skillPath)
                .pipe(Effect.orElseSucceed(() => ""));
              const hash = createHash("sha256").update(current).digest("hex");
              const proposed = applyValidatedSkillPatch({
                current,
                oldText: proposal.value.oldText,
                newText: proposal.value.newText,
              });
              if (hash !== proposal.value.originalHash || proposed === null) {
                yield* proposals.resolve({ proposalId, status: "stale", resolvedAt });
              } else {
                const temporary = `${proposal.value.skillPath}.${crypto.randomUUID()}.tmp`;
                yield* fs.writeFileString(temporary, proposed);
                yield* fs.rename(temporary, proposal.value.skillPath);
                yield* proposals.resolve({ proposalId, status: "applied", resolvedAt });
                yield* discovery.refresh(proposal.value.provider);
              }
            }
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`learning-skill-resolution:${proposalId}`),
            threadId: event.payload.threadId,
            activity: {
              id: EventId.makeUnsafe(crypto.randomUUID()),
              tone: "approval",
              kind: "approval.resolved",
              summary: "Skill improvement approval resolved",
              payload: { requestId: event.payload.requestId, decision: event.payload.decision },
              turnId: null,
              createdAt: resolvedAt,
            },
            createdAt: resolvedAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("skill proposal resolution failed", { cause: cause.toString() }),
          ),
        );
      }),
    );
    const interrupted = yield* learningJobs
      .recoverInterrupted({ now: new Date().toISOString() })
      .pipe(
        Effect.catch(() => {
          return Effect.logWarning("failed to recover interrupted learning reviews").pipe(
            Effect.as([]),
          );
        }),
      );
    yield* Effect.forEach(
      interrupted,
      (job) =>
        job.memoryUserMessageCount === null
          ? Effect.void
          : activityPublisher.outcome(
              job,
              "interrupted",
              "Memory review was interrupted and will recover",
            ),
      { concurrency: 1 },
    );
    yield* Effect.gen(function* () {
      const jobs = yield* learningJobs.listQueued();
      yield* Effect.forEach(
        jobs,
        (job) =>
          processJob(job).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("learning queue processing failed", { jobId: job.jobId }),
            ),
          ),
        { concurrency: 1 },
      );
    }).pipe(
      Effect.catchCause(() => Effect.logWarning("learning queue polling failed")),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
      Effect.forkScoped,
    );
  });

  return { start } satisfies LearningReactorShape;
});

export const LearningReactorLive = Layer.effect(LearningReactor, makeLearningReactor);
