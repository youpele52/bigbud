import { Schema } from "effect";

import { IsoDateTime, KanbanCardId, ProjectId, TrimmedNonEmptyString } from "../core/baseSchemas";

const KANBAN_TITLE_MAX_LENGTH = 200;
const KanbanTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_TITLE_MAX_LENGTH));

export const KanbanScope = Schema.Literals(["project", "global"]);
export type KanbanScope = typeof KanbanScope.Type;

export const KanbanStatus = Schema.Literals(["backlog", "todo", "ongoing", "done"]);
export type KanbanStatus = typeof KanbanStatus.Type;

export const KanbanCardSummary = Schema.Struct({
  cardId: KanbanCardId,
  projectId: Schema.NullOr(ProjectId),
  title: KanbanTitle,
  status: KanbanStatus,
  absolutePath: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type KanbanCardSummary = typeof KanbanCardSummary.Type;

export const KanbanCard = Schema.Struct({
  ...KanbanCardSummary.fields,
  content: Schema.String,
});
export type KanbanCard = typeof KanbanCard.Type;

export const KanbanListInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  scope: KanbanScope,
});
export type KanbanListInput = typeof KanbanListInput.Type;

export const KanbanListResult = Schema.Struct({
  cards: Schema.Array(KanbanCardSummary),
});
export type KanbanListResult = typeof KanbanListResult.Type;

export class KanbanListError extends Schema.TaggedErrorClass<KanbanListError>()("KanbanListError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const KanbanGetInput = Schema.Struct({
  cardId: KanbanCardId,
});
export type KanbanGetInput = typeof KanbanGetInput.Type;

export class KanbanGetError extends Schema.TaggedErrorClass<KanbanGetError>()("KanbanGetError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const KanbanCreateInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  title: Schema.optional(KanbanTitle),
  content: Schema.String,
  status: Schema.optional(KanbanStatus),
});
export type KanbanCreateInput = typeof KanbanCreateInput.Type;

export class KanbanCreateError extends Schema.TaggedErrorClass<KanbanCreateError>()(
  "KanbanCreateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const KanbanUpdateInput = Schema.Struct({
  cardId: KanbanCardId,
  title: KanbanTitle,
  content: Schema.String,
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type KanbanUpdateInput = typeof KanbanUpdateInput.Type;

export class KanbanUpdateError extends Schema.TaggedErrorClass<KanbanUpdateError>()(
  "KanbanUpdateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const KanbanDeleteInput = Schema.Struct({
  cardId: KanbanCardId,
});
export type KanbanDeleteInput = typeof KanbanDeleteInput.Type;

export const KanbanDeleteResult = Schema.Struct({
  cardId: KanbanCardId,
});
export type KanbanDeleteResult = typeof KanbanDeleteResult.Type;

export class KanbanDeleteError extends Schema.TaggedErrorClass<KanbanDeleteError>()(
  "KanbanDeleteError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const KanbanMoveInput = Schema.Struct({
  cardId: KanbanCardId,
  status: KanbanStatus,
  targetIndex: Schema.optional(Schema.Number),
});
export type KanbanMoveInput = typeof KanbanMoveInput.Type;

export class KanbanMoveError extends Schema.TaggedErrorClass<KanbanMoveError>()("KanbanMoveError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const KanbanReorderInput = Schema.Struct({
  cardId: KanbanCardId,
  status: KanbanStatus,
  targetIndex: Schema.Number,
});
export type KanbanReorderInput = typeof KanbanReorderInput.Type;

export class KanbanReorderError extends Schema.TaggedErrorClass<KanbanReorderError>()(
  "KanbanReorderError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
