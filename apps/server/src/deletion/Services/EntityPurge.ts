import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Layer, ServiceMap } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { PurgeJob } from "../../persistence/Services/PurgeJobRepository.ts";

export interface EntityPurgeShape {
  readonly requestThread: (
    threadId: ThreadId,
  ) => Effect.Effect<PurgeJob, ProjectionRepositoryError>;
  readonly requestProject: (
    projectId: ProjectId,
  ) => Effect.Effect<PurgeJob, ProjectionRepositoryError>;
  readonly run: (job: PurgeJob) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly auditAndResume: (limit?: number) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class EntityPurge extends ServiceMap.Service<EntityPurge, EntityPurgeShape>()(
  "t3/deletion/Services/EntityPurge",
) {}

const noopJob = (entityKind: "thread" | "project", entityId: string): PurgeJob => ({
  jobId: `test:${entityKind}:${entityId}`,
  entityKind,
  entityId,
  phase: "awaiting-finalization",
  status: "pending",
  resourceManifest: [],
  attemptCount: 0,
  lastError: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  completedAt: null,
});

export const EntityPurgeTest = Layer.succeed(EntityPurge, {
  requestThread: (threadId) => Effect.succeed(noopJob("thread", threadId)),
  requestProject: (projectId) => Effect.succeed(noopJob("project", projectId)),
  run: () => Effect.void,
  auditAndResume: () => Effect.void,
});
