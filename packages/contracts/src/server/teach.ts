import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "../core/baseSchemas";

export const TeachLearningProject = Schema.Struct({
  slug: TrimmedNonEmptyString,
  absolutePath: Schema.String,
  title: Schema.optional(TrimmedNonEmptyString),
  updatedAt: Schema.optional(IsoDateTime),
});
export type TeachLearningProject = typeof TeachLearningProject.Type;

export const TeachListProjectsInput = Schema.Struct({});
export type TeachListProjectsInput = typeof TeachListProjectsInput.Type;

export const TeachListProjectsResult = Schema.Struct({
  defaultChatCwd: Schema.String,
  learningRootPath: Schema.String,
  projects: Schema.Array(TeachLearningProject),
});
export type TeachListProjectsResult = typeof TeachListProjectsResult.Type;

export class TeachListProjectsError extends Schema.TaggedErrorClass<TeachListProjectsError>()(
  "TeachListProjectsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
