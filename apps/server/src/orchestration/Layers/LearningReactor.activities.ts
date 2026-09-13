import { CommandId, EventId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { LearningJob } from "../../persistence/Services/LearningJobs.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

const MEMORY_REVIEW_EXPIRY_MS = 4 * 60 * 1_000;

export type LearningMemoryOutcome =
  | "updated"
  | "unchanged"
  | "retrying"
  | "rejected"
  | "failed"
  | "interrupted";

type LearningMemoryJob = Pick<
  LearningJob,
  "jobId" | "threadId" | "turnId" | "attemptCount" | "memoryUserMessageCount"
>;

export function makeLearningActivityPublisher(orchestrationEngine: OrchestrationEngineShape) {
  const publish = (input: {
    readonly job: LearningMemoryJob;
    readonly phase: "started" | LearningMemoryOutcome;
    readonly summary: string;
    readonly scopes?: readonly string[];
    readonly createdAt?: string;
    readonly expiresAt?: string;
  }) => {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const activityId =
      input.phase === "started"
        ? `learning-started:${input.job.jobId}:${input.job.attemptCount}`
        : `learning-outcome:${input.job.jobId}:${input.job.attemptCount}:${input.phase}`;
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(activityId),
        threadId: input.job.threadId,
        activity: {
          id: EventId.makeUnsafe(activityId),
          tone: input.phase === "failed" || input.phase === "rejected" ? "error" : "info",
          kind: `learning.memory.${input.phase}`,
          summary: input.summary,
          payload: {
            jobId: input.job.jobId,
            attempt: input.job.attemptCount,
            scopes: input.scopes ?? [],
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          },
          turnId: input.job.turnId,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.asVoid,
        Effect.catch(() =>
          Effect.logWarning("failed to publish learning activity", {
            threadId: input.job.threadId,
            jobId: input.job.jobId,
            attempt: input.job.attemptCount,
            phase: input.phase,
          }),
        ),
      );
  };

  const started = (job: LearningMemoryJob, createdAt = new Date().toISOString()) => {
    const expiresAt = new Date(Date.parse(createdAt) + MEMORY_REVIEW_EXPIRY_MS).toISOString();
    return publish({
      job,
      phase: "started",
      summary: "Reviewing memory",
      createdAt,
      expiresAt,
    });
  };

  const outcome = (
    job: LearningMemoryJob,
    phase: LearningMemoryOutcome,
    summary: string,
    scopes: readonly string[] = [],
    createdAt = new Date().toISOString(),
  ) => publish({ job, phase, summary, scopes, createdAt });

  return { started, outcome };
}
