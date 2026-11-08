import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { ThreadSummary, ThreadSummaryCursor } from "./orchestration.catalog";
import { ThreadOrganizationState } from "./orchestration.organization";

export const ORGANIZATION_THREAD_SUMMARY_DEFAULT_LIMIT = 4;
export const ORGANIZATION_THREAD_SUMMARY_MAX_LIMIT = 50;

/**
 * One keyset page of active threads in an Inyosira state, across every project. Pages follow the
 * displayed order: latest user message (falling back to creation) descending, then thread id
 * descending.
 */
export const GetOrganizationThreadSummariesInput = Schema.Struct({
  state: ThreadOrganizationState,
  limit: Schema.optional(PositiveInt),
  cursor: Schema.optional(ThreadSummaryCursor),
  includeTotalCount: Schema.optional(Schema.Boolean),
});
export type GetOrganizationThreadSummariesInput = typeof GetOrganizationThreadSummariesInput.Type;

export const GetOrganizationThreadSummariesResult = Schema.Struct({
  projectionSequence: NonNegativeInt,
  state: ThreadOrganizationState,
  threads: Schema.Array(ThreadSummary),
  totalCount: Schema.optional(NonNegativeInt),
  nextCursor: Schema.optional(ThreadSummaryCursor),
});
export type GetOrganizationThreadSummariesResult = typeof GetOrganizationThreadSummariesResult.Type;

export class OrchestrationGetOrganizationThreadSummariesError extends Schema.TaggedErrorClass<OrchestrationGetOrganizationThreadSummariesError>()(
  "OrchestrationGetOrganizationThreadSummariesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
