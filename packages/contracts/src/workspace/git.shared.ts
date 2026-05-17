import { Schema } from "effect";
import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";

export const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
export const GIT_LIST_BRANCHES_MAX_LIMIT = 200;
export const ExecutionTargetInputShape = {
  executionTargetId: Schema.optional(ExecutionTargetId),
};
