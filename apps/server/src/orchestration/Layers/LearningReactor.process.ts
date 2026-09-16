import { CommandId, EventId } from "@bigbud/contracts";
import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { LearningReviewOutputError, reviewAndUpdateMemory } from "../../learning/LearningReview.ts";
import { applyValidatedSkillPatch } from "../../learning/LearningValidation.ts";
import { MemoryStore } from "../../learning/Services/MemoryStore.ts";
import {
  LearningJobRepository,
  type LearningJob,
} from "../../persistence/Services/LearningJobs.ts";
import { SkillChangeProposalRepository } from "../../persistence/Services/SkillChangeProposals.ts";
import { DiscoveryRegistry } from "../../provider/Services/DiscoveryRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { supportsProviderWorkload } from "../../provider/providerWorkloadSupport.ts";
import { ServerConfig } from "../../startup/config.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionOperationalStateQuery } from "../Services/ProjectionOperationalStateQuery.ts";
import { makeLearningActivityPublisher } from "./LearningReactor.activities.ts";
import { makeResolveSkillContext } from "./LearningReactor.skill.ts";

export const makeLearningJobProcessor = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const query = yield* ProjectionOperationalStateQuery;
  const learningJobs = yield* LearningJobRepository;
  const memoryStore = yield* MemoryStore;
  const config = yield* ServerConfig;
  const discovery = yield* DiscoveryRegistry;
  const proposals = yield* SkillChangeProposalRepository;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveSkillContext = makeResolveSkillContext({ discovery, fs, path });
  const activityPublisher = makeLearningActivityPublisher(orchestrationEngine);

  const reviewJob = Effect.fn("LearningReactor.reviewJob")(function* (job: LearningJob) {
    const readModel = yield* query.getThreadOperationalState(job.threadId);
    const model = Option.getOrUndefined(readModel);
    const current = model?.threads.find((entry) => entry.id === job.threadId);
    if (!current || current.deletedAt !== null || current.deletingAt != null)
      return yield* Effect.fail(new Error("Learning source thread unavailable"));
    const messages = yield* learningJobs.getReviewMessages({
      threadId: job.threadId,
      turnId: job.turnId,
    });
    const thread = { ...current, messages };
    const sourceUserMessage = messages.findLast((message) => message.role === "user")?.text;
    if (!sourceUserMessage)
      return yield* Effect.fail(new Error("Learning source turn unavailable"));
    const skill = yield* resolveSkillContext(sourceUserMessage, job.provider);
    const review = yield* reviewAndUpdateMemory({
      providerService,
      memoryStore,
      config,
      thread,
      projects: model!.projects,
      jobId: job.jobId,
      turnId: job.turnId,
      modelSelection: job.modelSelection,
      sourceUserMessage,
      memoryReviewEnabled: job.memoryUserMessageCount !== null,
      ...(skill ? { skillContext: skill.context } : {}),
    });
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
      const proposalId = `learning-${createHash("sha256").update(`${job.jobId}:${skill.context.path}`).digest("hex")}`;
      const createdAt = new Date().toISOString();
      const existing = yield* proposals.getById(proposalId);
      const proposal =
        existing._tag === "Some"
          ? existing.value
          : ({
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
            } as const);
      if (existing._tag === "None") yield* proposals.create(proposal);
      if (proposal.status === "pending")
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`learning-skill-proposal:${proposalId}`),
          threadId: job.threadId,
          activity: {
            id: EventId.makeUnsafe(`learning-skill-proposal:${proposalId}`),
            tone: "approval",
            kind: "approval.requested",
            summary: "Skill improvement approval requested",
            payload: {
              requestId: `learning-skill:${proposalId}`,
              requestKind: "file-change",
              detail: `${proposal.reason}\n\n${proposal.skillPath}\n\n--- current\n${proposal.oldText}\n+++ proposed\n${proposal.newText}`,
              sessionApprovalAvailable: false,
            },
            turnId: job.turnId,
            createdAt: proposal.createdAt,
          },
          createdAt: proposal.createdAt,
        });
    }

    const outcome = review.changed.length > 0 ? "updated" : "unchanged";
    yield* learningJobs.setState({
      jobId: job.jobId,
      state: "completed",
      updatedAt: new Date().toISOString(),
      nextAttemptAt: null,
      outcome,
    });
    if (job.memoryUserMessageCount !== null)
      yield* activityPublisher.outcome(
        job,
        outcome,
        outcome === "updated" ? "Memory updated" : "Memory reviewed; no changes needed",
        review.changed,
      );
  });

  return Effect.fn("LearningReactor.processJob")(function* (queued: LearningJob) {
    const job = yield* learningJobs.claim({ jobId: queued.jobId, now: new Date().toISOString() });
    if (!job) return;
    if (!supportsProviderWorkload(job.provider, "learning")) {
      yield* learningJobs.setState({
        jobId: job.jobId,
        state: "requires-reselection",
        updatedAt: new Date().toISOString(),
        outcome: "unsupported-provider",
      });
      return;
    }
    yield* Effect.acquireUseRelease(
      learningJobs.acquireLease({ jobId: job.jobId, threadId: job.threadId }),
      (acquired) =>
        acquired
          ? job.memoryUserMessageCount !== null
            ? activityPublisher.started(job).pipe(Effect.andThen(reviewJob(job)))
            : reviewJob(job)
          : Effect.fail(new Error("Learning owner unavailable")),
      (acquired, exit) =>
        !acquired ||
        (Exit.isFailure(exit) &&
          Cause.pretty(exit.cause).includes("ProviderService.runBackgroundReview.cleanup"))
          ? Effect.void
          : learningJobs.releaseLease(job.jobId).pipe(Effect.orDie),
    ).pipe(
      Effect.catchCause((cause) => {
        const error = Option.getOrUndefined(Cause.findErrorOption(cause));
        const rejected = error instanceof LearningReviewOutputError;
        const cleanupFailed = Cause.pretty(cause).includes(
          "ProviderService.runBackgroundReview.cleanup",
        );
        const retry = !cleanupFailed && job.attemptCount < 3;
        const outcome = rejected ? "rejected" : retry ? "retrying" : "failed";
        return learningJobs
          .setState({
            jobId: job.jobId,
            state: retry ? "queued" : "failed",
            updatedAt: new Date().toISOString(),
            nextAttemptAt: retry
              ? new Date(Date.now() + (job.attemptCount === 1 ? 30_000 : 120_000)).toISOString()
              : null,
            outcome,
          })
          .pipe(
            Effect.andThen(
              job.memoryUserMessageCount === null
                ? Effect.void
                : activityPublisher.outcome(
                    job,
                    outcome,
                    rejected
                      ? "Memory review output was rejected"
                      : retry
                        ? "Memory review could not finish; a retry is scheduled"
                        : cleanupFailed
                          ? "Memory review stopped because its session could not be closed"
                          : "Memory review failed after three attempts",
                  ),
            ),
            Effect.andThen(
              Effect.logWarning("learning review failed", {
                threadId: job.threadId,
                jobId: job.jobId,
                attempt: job.attemptCount,
                outcome,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }),
    );
  });
});
