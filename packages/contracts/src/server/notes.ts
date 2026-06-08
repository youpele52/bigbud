import { Schema } from "effect";

import { IsoDateTime, NoteId, ProjectId, TrimmedNonEmptyString } from "../core/baseSchemas";

const NOTE_TITLE_MAX_LENGTH = 200;
const NoteTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(NOTE_TITLE_MAX_LENGTH));

export const NoteScope = Schema.Literals(["project", "global"]);
export type NoteScope = typeof NoteScope.Type;

export const NoteSummary = Schema.Struct({
  noteId: NoteId,
  projectId: Schema.NullOr(ProjectId),
  title: NoteTitle,
  absolutePath: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NoteSummary = typeof NoteSummary.Type;

export const Note = Schema.Struct({
  ...NoteSummary.fields,
  content: Schema.String,
});
export type Note = typeof Note.Type;

export const NotesListInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  scope: NoteScope,
});
export type NotesListInput = typeof NotesListInput.Type;

export const NotesListResult = Schema.Struct({
  notes: Schema.Array(NoteSummary),
});
export type NotesListResult = typeof NotesListResult.Type;

export class NotesListError extends Schema.TaggedErrorClass<NotesListError>()("NotesListError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const NotesGetInput = Schema.Struct({
  noteId: NoteId,
});
export type NotesGetInput = typeof NotesGetInput.Type;

export class NotesGetError extends Schema.TaggedErrorClass<NotesGetError>()("NotesGetError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const NotesCreateInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  title: Schema.optional(NoteTitle),
  content: Schema.String,
});
export type NotesCreateInput = typeof NotesCreateInput.Type;

export class NotesCreateError extends Schema.TaggedErrorClass<NotesCreateError>()(
  "NotesCreateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const NotesUpdateInput = Schema.Struct({
  noteId: NoteId,
  title: Schema.optional(NoteTitle),
  content: Schema.String,
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type NotesUpdateInput = typeof NotesUpdateInput.Type;

export class NotesUpdateError extends Schema.TaggedErrorClass<NotesUpdateError>()(
  "NotesUpdateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const NotesDeleteInput = Schema.Struct({
  noteId: NoteId,
});
export type NotesDeleteInput = typeof NotesDeleteInput.Type;

export const NotesDeleteResult = Schema.Struct({
  noteId: NoteId,
});
export type NotesDeleteResult = typeof NotesDeleteResult.Type;

export class NotesDeleteError extends Schema.TaggedErrorClass<NotesDeleteError>()(
  "NotesDeleteError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
