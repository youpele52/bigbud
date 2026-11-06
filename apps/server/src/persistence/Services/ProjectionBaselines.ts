import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export type ProjectionBaselineStatus = "candidate" | "verified" | "rejected";

/**
 * Baseline metadata only. The payload lives in `projection_baseline_rows`, one row per
 * projection row, and is only ever read page by page through a `BaselinePayloadSource`.
 */
export interface ProjectionBaseline {
  readonly baselineId: number;
  readonly sequence: number;
  readonly formatVersion: number;
  readonly payloadHash: string;
  readonly verificationStatus: ProjectionBaselineStatus;
  readonly verificationDetail: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
}

export interface BaselinePayloadRow {
  readonly ordinal: number;
  readonly rowJson: string;
}

/** Page-wise access to one baseline payload, so no caller holds a whole baseline in memory. */
export interface BaselinePayloadSource {
  /** Expected sha256 of the canonical payload document; `null` skips the integrity check. */
  readonly payloadHash: string | null;
  readonly readTablePage: (
    table: string,
    afterOrdinal: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BaselinePayloadRow>, ProjectionRepositoryError>;
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
  /** Sequence of the newest verified baseline, without loading or validating its payload. */
  readonly latestVerifiedSequence: () => Effect.Effect<
    Option.Option<number>,
    ProjectionRepositoryError
  >;
  /** Reads a stored baseline's rows page by page; restore checks them against its hash. */
  readonly payloadSource: (baseline: ProjectionBaseline) => BaselinePayloadSource;
  /** Hash of the current projections in baseline form, without storing them. */
  readonly captureDigest: () => Effect.Effect<string, ProjectionRepositoryError>;
  readonly restorePayload: (
    source: BaselinePayloadSource,
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
