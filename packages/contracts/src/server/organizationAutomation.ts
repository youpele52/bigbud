import * as Schema from "effect/Schema";
import { ThreadId } from "../core/baseSchemas";
export const ORGANIZATION_AUTOMATION_METHODS = {
  status: "orchestration.organizationStatus",
  engagement: "orchestration.organizationEngagement",
} as const;
export const OrganizationAutomationStatus = Schema.Struct({
  state: Schema.Literals(["syncing", "healthy", "paused"]),
  changedAtMs: Schema.Number,
  installation: Schema.Literals(["new", "existing"]),
  /** Present only while paused by a terminal limit that waits for a settings change. */
  reason: Schema.optional(Schema.Literals(["thread-limit", "capture-time"])),
});
export type OrganizationAutomationStatus = typeof OrganizationAutomationStatus.Type;
export const OrganizationEngagementInput = Schema.Struct({
  threadId: ThreadId,
  engaged: Schema.Boolean,
});
export type OrganizationEngagementInput = typeof OrganizationEngagementInput.Type;

export class OrganizationAutomationError extends Schema.TaggedErrorClass<OrganizationAutomationError>()(
  "OrganizationAutomationError",
  { message: Schema.String },
) {}
