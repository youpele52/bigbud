import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export type ProjectionBaselineStatus = "candidate" | "verified" | "rejected";

export interface ProjectionBaseline {
  readonly baselineId: number;
  readonly sequence: number;
  readonly formatVersion: number;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly verificationStatus: ProjectionBaselineStatus;
  readonly verificationDetail: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
}

export interface ProjectionBaselineRepositoryShape {
  readonly createCandidate: (
    requiredProjectors: ReadonlyArray<string>,
  ) => Effect.Effect<Option.Option<ProjectionBaseline>, ProjectionRepositoryError>;
  readonly getById: (
    baselineId: number,
  ) => Effect.Effect<Option.Option<ProjectionBaseline>, ProjectionRepositoryError>;
  readonly latestVerified: () => Effect.Effect<
    Option.Option<ProjectionBaseline>,
    ProjectionRepositoryError
  >;
  readonly capturePayload: () => Effect.Effect<string, ProjectionRepositoryError>;
  readonly restorePayload: (
    payloadJson: string,
    sequence: number,
    requiredProjectors: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markVerified: (
    baselineId: number,
    sequence: number,
    verifiedAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markRejected: (
    baselineId: number,
    detail: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionBaselineRepository extends ServiceMap.Service<
  ProjectionBaselineRepository,
  ProjectionBaselineRepositoryShape
>()("bigbud/persistence/Services/ProjectionBaselineRepository") {}
