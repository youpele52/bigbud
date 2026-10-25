import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";

/** Stop one provider subagent by its native task ID. Stop-all is unchanged. */
export const ProviderStopSubagentInput = Schema.Struct({
  threadId: ThreadId,
  nativeTaskId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ProviderStopSubagentInput = typeof ProviderStopSubagentInput.Type;

export class ProviderStopSubagentError extends Schema.TaggedErrorClass<ProviderStopSubagentError>()(
  "ProviderStopSubagentError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
