import { CommandId, EventId, type TurnId } from "@bigbud/contracts";
import { makeDrainableWorker } from "@bigbud/shared/DrainableWorker";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";

import { reviewAndUpdateMemory } from "../../learning/LearningReview.ts";
import { applyValidatedSkillPatch } from "../../learning/LearningValidation.ts";
import { resolveSkillMutationPolicy } from "../../learning/SkillMutationPolicy.ts";
import { MemoryStore } from "../../learning/Services/MemoryStore.ts";
import { LearningJobRepository } from "../../persistence/Services/LearningJobs.ts";
import type { LearningJob } from "../../persistence/Services/LearningJobs.ts";
import { SkillChangeProposalRepository } from "../../persistence/Services/SkillChangeProposals.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { supportsProviderWorkload } from "../../provider/providerWorkloadSupport.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { LearningReactor, type LearningReactorShape } from "../Services/LearningReactor.ts";
import * as LearningReactorLogic from "./LearningReactor.logic.ts";
import { makeResolveSkillContext, resolveSkillName } from "./LearningReactor.skill.ts";

const makeLearningReactor = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const learningJobs = yield* LearningJobRepository;
  const memoryStore = yield* MemoryStore;
  const config = yield* ServerConfig;
  const discovery = yield* DiscoveryRegistry;
  const proposals = yield* SkillChangeProposalRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const turnModels = new Map<string, string>();
  const activeJobs = new Set<string>();

  const resolveSkillContext = makeResolveSkillContext({ discovery, fs, path });

  const processJob = Effect.fn("LearningReactor.processJob")(function* (job: LearningJob) {
    if (activeJobs.has(job.jobId)) return;
    activeJobs.add(job.jobId);
    if (!supportsProviderWorkload(job.provider, "learning")) {
      yield* learningJobs.setState({
        jobId: job.jobId,
        state: "requires-reselection",
        updatedAt: new Date().toISOString(),
      });
      activeJobs.delete(job.jobId);
      return;
    }
    yield* learningJobs.setState({
      jobId: job.jobId,
      state: "reviewing",
      updatedAt: new Date().toISOString(),
    });
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === job.threadId);
    if (!thread) {
      yield* learningJobs.setState({
        jobId: job.jobId,
        state: "failed",
        updatedAt: new Date().toISOString(),
      });
      activeJobs.delete(job.jobId);
      return;
    }
    const turnMessages = thread.messages.filter((message) => message.turnId === job.turnId);
    const turnStartedAt = turnMessages.at(0)?.createdAt ?? job.createdAt;
    const sourceUserMessage =
      turnMessages.find((message) => message.role === "user")?.text ??
      thread.messages.findLast(
        (message) => message.role === "user" && message.createdAt <= turnStartedAt,
      )?.text;
    if (!sourceUserMessage) {
      yield* learningJobs.setState({
        jobId: job.jobId,
        state: "failed",
        updatedAt: new Date().toISOString(),
      });
      activeJobs.delete(job.jobId);
      return;
    }
    const skill = yield* resolveSkillContext(sourceUserMessage, job.provider);
    const review = yield* reviewAndUpdateMemory({
      providerService,
      memoryStore,
      config,
      thread,
      projects: readModel.projects,
      turnId: job.turnId,
      modelSelection: job.modelSelection,
      sourceUserMessage,
      memoryReviewEnabled: job.memoryUserMessageCount !== null,
      ...(skill ? { skillContext: skill.context } : {}),
    });
    const completedAt = new Date().toISOString();
    yield* learningJobs.setState({ jobId: job.jobId, state: "completed", updatedAt: completedAt });
    if (review.changed.length > 0) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`learning-memory:${crypto.randomUUID()}`),
          threadId: job.threadId,
          activity: {
            id: EventId.makeUnsafe(crypto.randomUUID()),
            tone: "info",
            kind: "learning.memory.updated",
            summary: "Memory updated",
            payload: { scopes: review.changed },
            turnId: job.turnId as TurnId,
            createdAt: completedAt,
          },
          createdAt: completedAt,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to publish memory update notification", {
              threadId: job.threadId,
              error: error.message,
            }),
          ),
        );
    }
    if (
      skill &&
      review.skillPatch &&
      review.skillPatch.oldText !== review.skillPatch.newText &&
      applyValidatedSkillPatch({
        current: skill.context.content,
        oldText: review.skillPatch.oldText,
        newText: review.skillPatch.newText,
      }) !== null
    ) {
      const proposalId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      yield* proposals.create({
        proposalId,
        threadId: job.threadId,
        turnId: job.turnId,
        provider: job.provider,
        skillPath: skill.context.path,
        originalHash: createHash("sha256").update(skill.context.content).digest("hex"),
        oldText: review.skillPatch.oldText,
        newText: review.skillPatch.newText,
        reason: review.skillPatch.reason,
        status: "pending",
        createdAt,
        resolvedAt: null,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`learning-skill-proposal:${proposalId}`),
        threadId: job.threadId,
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: "approval",
          kind: "approval.requested",
          summary: "Skill improvement approval requested",
          payload: {
            requestId: `learning-skill:${proposalId}`,
            requestKind: "file-change",
            detail: `${review.skillPatch.reason}\n\n${skill.context.path}\n\n--- current\n${review.skillPatch.oldText}\n+++ proposed\n${review.skillPatch.newText}`,
            sessionApprovalAvailable: false,
          },
          turnId: job.turnId as TurnId,
          createdAt,
        },
        createdAt,
      });
    }
    activeJobs.delete(job.jobId);
  });

  const processJobSafely = (job: LearningJob) =>
    processJob(job).pipe(
      Effect.catchCause((cause) =>
        learningJobs
          .setState({ jobId: job.jobId, state: "failed", updatedAt: new Date().toISOString() })
          .pipe(
            Effect.catch(() => Effect.void),
            Effect.tap(() => Effect.sync(() => activeJobs.delete(job.jobId))),
            Effect.tap(() =>
              Effect.logWarning("learning review failed", {
                threadId: job.threadId,
                turnId: job.turnId,
                cause: cause.toString(),
              }),
            ),
          ),
      ),
    );
  const worker = yield* makeDrainableWorker(processJobSafely);

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
        if (event.type !== "turn.completed" || event.payload.state !== "completed") {
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
          const userMessageCount = LearningReactorLogic.countFinalizedUserMessages(thread.messages);
          const latestMemoryUserMessageCount = yield* learningJobs.getLatestMemoryUserMessageCount({
            threadId: thread.id,
          });
          const memoryUserMessageCount = LearningReactorLogic.shouldScheduleMemoryReview({
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
          } satisfies LearningJob;
          const created = yield* learningJobs.createIfAbsent(job);
          if (created) yield* worker.enqueue(job);
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
    const queued = yield* learningJobs.listQueued().pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to restore queued learning jobs", {
          error: error.message,
        }).pipe(Effect.as([] as ReadonlyArray<LearningJob>)),
      ),
    );
    yield* Effect.forEach(
      queued,
      (job) =>
        supportsProviderWorkload(job.provider, "learning")
          ? worker.enqueue(job)
          : learningJobs
              .setState({
                jobId: job.jobId,
                state: "requires-reselection",
                updatedAt: new Date().toISOString(),
              })
              .pipe(Effect.catch(() => Effect.void)),
      { concurrency: 1 },
    );
  });

  return { start } satisfies LearningReactorShape;
});

export const LearningReactorLive = Layer.effect(LearningReactor, makeLearningReactor);
