import { NoteId, ProjectId } from "@bigbud/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionNote = Schema.Struct({
  noteId: NoteId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  absolutePath: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProjectionNote = typeof ProjectionNote.Type;

export const ListProjectionNotesInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  scope: Schema.Literals(["project", "global"]),
});
export type ListProjectionNotesInput = typeof ListProjectionNotesInput.Type;

export const GetProjectionNoteInput = Schema.Struct({
  noteId: NoteId,
});
export type GetProjectionNoteInput = typeof GetProjectionNoteInput.Type;

export const CreateProjectionNoteInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  content: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CreateProjectionNoteInput = typeof CreateProjectionNoteInput.Type;

export const UpdateProjectionNoteInput = Schema.Struct({
  noteId: NoteId,
  title: Schema.String,
  content: Schema.String,
  updatedAt: Schema.String,
});
export type UpdateProjectionNoteInput = typeof UpdateProjectionNoteInput.Type;

export const DeleteProjectionNoteInput = Schema.Struct({
  noteId: NoteId,
});
export type DeleteProjectionNoteInput = typeof DeleteProjectionNoteInput.Type;

export interface ProjectionNoteRepositoryShape {
  readonly list: (
    input: ListProjectionNotesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionNote>, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionNoteInput,
  ) => Effect.Effect<Option.Option<ProjectionNote>, ProjectionRepositoryError>;
  readonly create: (
    input: CreateProjectionNoteInput,
  ) => Effect.Effect<ProjectionNote, ProjectionRepositoryError>;
  readonly update: (
    input: UpdateProjectionNoteInput,
  ) => Effect.Effect<ProjectionNote, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionNoteInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionNoteRepository extends ServiceMap.Service<
  ProjectionNoteRepository,
  ProjectionNoteRepositoryShape
>()("t3/persistence/Services/ProjectionNotes/ProjectionNoteRepository") {}
