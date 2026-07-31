import {
  ApprovalRequestId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TurnId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPendingUserInputStatus = Schema.Literals(["pending", "resolved"]);

export const ProjectionPendingUserInput = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  status: ProjectionPendingUserInputStatus,
  questions: Schema.Array(UserInputQuestion),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionPendingUserInput = typeof ProjectionPendingUserInput.Type;

export const GetProjectionPendingUserInputInput = Schema.Struct({ requestId: ApprovalRequestId });
export const DeleteProjectionPendingUserInputsByThreadInput = Schema.Struct({ threadId: ThreadId });
export const DeleteProjectionPendingUserInputsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});

export interface ProjectionPendingUserInputRepositoryShape {
  readonly upsert: (
    row: ProjectionPendingUserInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByRequestId: (
    input: typeof GetProjectionPendingUserInputInput.Type,
  ) => Effect.Effect<Option.Option<ProjectionPendingUserInput>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: typeof DeleteProjectionPendingUserInputsByThreadInput.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByProjectId: (
    input: typeof DeleteProjectionPendingUserInputsByProjectInput.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionPendingUserInputRepository extends ServiceMap.Service<
  ProjectionPendingUserInputRepository,
  ProjectionPendingUserInputRepositoryShape
>()(
  "bigbud/persistence/Services/ProjectionPendingUserInputs/ProjectionPendingUserInputRepository",
) {}
