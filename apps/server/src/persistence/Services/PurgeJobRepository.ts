import { IsoDateTime, NonNegativeInt } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PurgeEntityKind = Schema.Literals(["thread", "project"]);
export type PurgeEntityKind = typeof PurgeEntityKind.Type;

export const PurgeJobPhase = Schema.Literals(["marking", "database", "files", "verifying", "root"]);
export type PurgeJobPhase = typeof PurgeJobPhase.Type;

export const PurgeJobStatus = Schema.Literals(["pending", "running", "failed", "completed"]);
export type PurgeJobStatus = typeof PurgeJobStatus.Type;

export const PurgeResource = Schema.Struct({
  kind: Schema.Literals([
    "attachment",
    "project-memory",
    "project-notes",
    "project-kanban",
    "managed-worktree",
  ]),
  relativePath: Schema.String,
});
export type PurgeResource = typeof PurgeResource.Type;

export const PurgeResourceManifest = Schema.Array(PurgeResource);
export type PurgeResourceManifest = typeof PurgeResourceManifest.Type;

export const PurgeJob = Schema.Struct({
  jobId: Schema.String,
  entityKind: PurgeEntityKind,
  entityId: Schema.String,
  phase: PurgeJobPhase,
  status: PurgeJobStatus,
  resourceManifest: Schema.fromJsonString(PurgeResourceManifest),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type PurgeJob = typeof PurgeJob.Type;

export const CreatePurgeJobInput = Schema.Struct({
  jobId: Schema.String,
  entityKind: PurgeEntityKind,
  entityId: Schema.String,
  resourceManifest: PurgeResourceManifest,
  createdAt: IsoDateTime,
});
export type CreatePurgeJobInput = typeof CreatePurgeJobInput.Type;

export const FindIncompletePurgeJobInput = Schema.Struct({
  entityKind: PurgeEntityKind,
  entityId: Schema.String,
});
export type FindIncompletePurgeJobInput = typeof FindIncompletePurgeJobInput.Type;

export const UpdatePurgeJobInput = Schema.Struct({
  jobId: Schema.String,
  phase: PurgeJobPhase,
  status: PurgeJobStatus,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdatePurgeJobInput = typeof UpdatePurgeJobInput.Type;

export const CompletePurgeJobInput = Schema.Struct({
  jobId: Schema.String,
  completedAt: IsoDateTime,
});
export type CompletePurgeJobInput = typeof CompletePurgeJobInput.Type;

export interface PurgeJobRepositoryShape {
  readonly createOrGet: (
    input: CreatePurgeJobInput,
  ) => Effect.Effect<PurgeJob, ProjectionRepositoryError>;
  readonly findIncomplete: (
    input: FindIncompletePurgeJobInput,
  ) => Effect.Effect<Option.Option<PurgeJob>, ProjectionRepositoryError>;
  readonly listIncomplete: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PurgeJob>, ProjectionRepositoryError>;
  readonly update: (input: UpdatePurgeJobInput) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly complete: (
    input: CompletePurgeJobInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class PurgeJobRepository extends ServiceMap.Service<
  PurgeJobRepository,
  PurgeJobRepositoryShape
>()("t3/persistence/Services/PurgeJobRepository") {}
