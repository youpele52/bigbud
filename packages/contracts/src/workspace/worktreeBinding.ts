import { Schema } from "effect";
import { ExecutionTargetId, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";

/** A persisted draft selects a physical directory, not whichever folder later reuses its path. */
export const WorktreeBinding = Schema.Struct({
  path: TrimmedNonEmptyString,
  identity: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  executionTargetId: ExecutionTargetId,
  revision: NonNegativeInt,
});
export type WorktreeBinding = typeof WorktreeBinding.Type;
