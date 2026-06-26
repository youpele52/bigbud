import { KanbanCardId, ProjectId } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionKanbanCard = Schema.Struct({
  cardId: KanbanCardId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  status: Schema.Literals(["backlog", "todo", "ongoing", "done"]),
  absolutePath: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProjectionKanbanCard = typeof ProjectionKanbanCard.Type;

export const ListProjectionKanbanCardsInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  scope: Schema.Literals(["project", "global"]),
});
export type ListProjectionKanbanCardsInput = typeof ListProjectionKanbanCardsInput.Type;

export const GetProjectionKanbanCardInput = Schema.Struct({
  cardId: KanbanCardId,
});
export type GetProjectionKanbanCardInput = typeof GetProjectionKanbanCardInput.Type;

export const CreateProjectionKanbanCardInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  content: Schema.String,
  status: Schema.Literals(["backlog", "todo", "ongoing", "done"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CreateProjectionKanbanCardInput = typeof CreateProjectionKanbanCardInput.Type;

export const UpdateProjectionKanbanCardInput = Schema.Struct({
  cardId: KanbanCardId,
  title: Schema.String,
  content: Schema.String,
  updatedAt: Schema.String,
});
export type UpdateProjectionKanbanCardInput = typeof UpdateProjectionKanbanCardInput.Type;

export const MoveProjectionKanbanCardInput = Schema.Struct({
  cardId: KanbanCardId,
  status: Schema.Literals(["backlog", "todo", "ongoing", "done"]),
  targetIndex: Schema.optional(Schema.Number),
  updatedAt: Schema.String,
});
export type MoveProjectionKanbanCardInput = typeof MoveProjectionKanbanCardInput.Type;

export const ReorderProjectionKanbanCardInput = Schema.Struct({
  cardId: KanbanCardId,
  status: Schema.Literals(["backlog", "todo", "ongoing", "done"]),
  targetIndex: Schema.Number,
  updatedAt: Schema.String,
});
export type ReorderProjectionKanbanCardInput = typeof ReorderProjectionKanbanCardInput.Type;

export const DeleteProjectionKanbanCardInput = Schema.Struct({
  cardId: KanbanCardId,
});
export type DeleteProjectionKanbanCardInput = typeof DeleteProjectionKanbanCardInput.Type;

export interface ProjectionKanbanRepositoryShape {
  readonly list: (
    input: ListProjectionKanbanCardsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionKanbanCard>, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionKanbanCardInput,
  ) => Effect.Effect<Option.Option<ProjectionKanbanCard>, ProjectionRepositoryError>;
  readonly create: (
    input: CreateProjectionKanbanCardInput,
  ) => Effect.Effect<ProjectionKanbanCard, ProjectionRepositoryError>;
  readonly update: (
    input: UpdateProjectionKanbanCardInput,
  ) => Effect.Effect<ProjectionKanbanCard, ProjectionRepositoryError>;
  readonly move: (
    input: MoveProjectionKanbanCardInput,
  ) => Effect.Effect<ProjectionKanbanCard, ProjectionRepositoryError>;
  readonly reorderWithinStatus: (
    input: ReorderProjectionKanbanCardInput,
  ) => Effect.Effect<ProjectionKanbanCard, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionKanbanCardInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionKanbanRepository extends ServiceMap.Service<
  ProjectionKanbanRepository,
  ProjectionKanbanRepositoryShape
>()("t3/persistence/Services/ProjectionKanban/ProjectionKanbanRepository") {}
