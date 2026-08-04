import { IsoDateTime, NonNegativeInt } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PurgeEntityKind = Schema.Literals(["thread", "project"]);
export type PurgeEntityKind = typeof PurgeEntityKind.Type;

export const PurgeJobPhase = Schema.Literals([
  "awaiting-finalization",
  "baseline",
  "database",
  "files",
  "verifying",
  "root",
]);
export type PurgeJobPhase = typeof PurgeJobPhase.Type;

export const PurgeJobStatus = Schema.Literals([
  "pending",
  "running",
  "failed",
  "completed",
  "manual_recovery_required",
]);
export type PurgeJobStatus = typeof PurgeJobStatus.Type;

export const PurgePathIdentity = Schema.Struct({
  canonicalPath: Schema.String,
  device: NonNegativeInt,
  inode: NonNegativeInt,
});
export type PurgePathIdentity = typeof PurgePathIdentity.Type;

export const PurgeResourceIdentity = Schema.Struct({
  declaredPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  canonicalPath: Schema.String,
  device: NonNegativeInt,
  inode: NonNegativeInt,
  changedAtMs: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(() => null)),
  type: Schema.Literals(["file", "directory"]),
  root: Schema.NullOr(PurgePathIdentity).pipe(Schema.withDecodingDefault(() => null)),
  parent: Schema.NullOr(PurgePathIdentity).pipe(Schema.withDecodingDefault(() => null)),
});
export type PurgeResourceIdentity = typeof PurgeResourceIdentity.Type;

export const PurgeResource = Schema.Struct({
  kind: Schema.Literals([
    "attachment",
    "provider-log",
    "terminal-history",
    "project-memory",
    "project-notes",
    "project-kanban",
    "managed-worktree",
  ]),
  relativePath: Schema.String,
  identity: Schema.NullOr(PurgeResourceIdentity).pipe(Schema.withDecodingDefault(() => null)),
  quarantineName: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(() => null)),
  action: Schema.Literals(["delete", "retain-shared"]).pipe(
    Schema.withDecodingDefault(() => "delete" as const),
  ),
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
  manifestDigest: Schema.NullOr(Schema.String),
  manifestSealedAt: Schema.NullOr(IsoDateTime),
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

export const BindPurgeManifestInput = Schema.Struct({
  jobId: Schema.String,
  expectedManifestJson: Schema.String,
  expectedUpdatedAt: IsoDateTime,
  resourceManifest: PurgeResourceManifest,
  updatedAt: IsoDateTime,
});
export type BindPurgeManifestInput = typeof BindPurgeManifestInput.Type;

export const ClaimPurgeResourcesInput = Schema.Struct({
  jobId: Schema.String,
  entityKind: PurgeEntityKind,
  entityId: Schema.String,
  resourceManifest: PurgeResourceManifest,
  claimedAt: IsoDateTime,
});
export type ClaimPurgeResourcesInput = typeof ClaimPurgeResourcesInput.Type;

export const UpdatePurgeJobInput = Schema.Struct({
  jobId: Schema.String,
  phase: PurgeJobPhase,
  status: PurgeJobStatus,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdatePurgeJobInput = typeof UpdatePurgeJobInput.Type;

export const TransitionPurgeJobInput = Schema.Struct({
  jobId: Schema.String,
  expectedPhase: PurgeJobPhase,
  nextPhase: PurgeJobPhase,
  updatedAt: IsoDateTime,
});
export type TransitionPurgeJobInput = typeof TransitionPurgeJobInput.Type;

export const CompletePurgeJobInput = Schema.Struct({
  jobId: Schema.String,
  completedAt: IsoDateTime,
});
export type CompletePurgeJobInput = typeof CompletePurgeJobInput.Type;

export const ClaimPurgeExecutionInput = Schema.Struct({
  jobId: Schema.String,
  leaseId: Schema.String,
  claimedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ClaimPurgeExecutionInput = typeof ClaimPurgeExecutionInput.Type;

export const PURGE_MAX_ATTEMPTS = 5;

export interface PurgeJobRepositoryShape {
  readonly createOrGet: (
    input: CreatePurgeJobInput,
  ) => Effect.Effect<PurgeJob, ProjectionRepositoryError>;
  readonly findIncomplete: (
    input: FindIncompletePurgeJobInput,
  ) => Effect.Effect<Option.Option<PurgeJob>, ProjectionRepositoryError>;
  readonly findById: (
    jobId: string,
  ) => Effect.Effect<Option.Option<PurgeJob>, ProjectionRepositoryError>;
  readonly listIncomplete: (
    limit: number,
    dueAt?: string,
  ) => Effect.Effect<ReadonlyArray<PurgeJob>, ProjectionRepositoryError>;
  readonly countIncomplete: () => Effect.Effect<number, ProjectionRepositoryError>;
  readonly claimExecution: (
    input: ClaimPurgeExecutionInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly releaseExecution: (
    jobId: string,
    leaseId: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly bindManifest: (
    input: BindPurgeManifestInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly claimResources: (
    input: ClaimPurgeResourcesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly releaseClaims: (jobId: string) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly update: (
    input: UpdatePurgeJobInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly transition: (
    input: TransitionPurgeJobInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly complete: (
    input: CompletePurgeJobInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class PurgeJobRepository extends ServiceMap.Service<
  PurgeJobRepository,
  PurgeJobRepositoryShape
>()("t3/persistence/Services/PurgeJobRepository") {}
