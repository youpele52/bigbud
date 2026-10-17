import { Schema } from "effect";

export const APPROVAL_INTENT_MAX_CHARS = 65536;
/** Complete, inspectable execution intent; distinct from the abbreviated activity detail. */
export const ApprovalExecutionIntent = Schema.Struct({
  format: Schema.Literal("json"),
  content: Schema.String.check(Schema.isMaxLength(APPROVAL_INTENT_MAX_CHARS)),
});
export type ApprovalExecutionIntent = typeof ApprovalExecutionIntent.Type;
