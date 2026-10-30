import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "../core/baseSchemas";
import { McpServerStatusList } from "../orchestration/providerRuntime.mcp";

/** Native maintenance never accepts a browser-supplied provider or native thread id. */
export const ProviderControlsInput = Schema.Struct({
  threadId: ThreadId,
  sessionEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  action: Schema.Literals(["status", "compact", "refresh-mcp", "reload-mcp"]),
});
export type ProviderControlsInput = typeof ProviderControlsInput.Type;
export const ProviderControlAvailability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.String,
});
export const ProviderCompactState = Schema.Literals([
  "idle",
  "submitted",
  "working",
  "completed",
  "failed",
  "unknown",
]);
export type ProviderCompactState = typeof ProviderCompactState.Type;
export const ProviderControlsSnapshot = Schema.Struct({
  threadId: ThreadId,
  sessionEpoch: Schema.Number,
  compact: ProviderControlAvailability,
  mcpStatus: ProviderControlAvailability,
  mcpReload: ProviderControlAvailability,
  mcpTargeted: ProviderControlAvailability,
  compactState: ProviderCompactState,
  servers: Schema.optional(McpServerStatusList),
  reloadState: Schema.optional(Schema.Literals(["completed", "failed", "unknown"])),
  message: Schema.optional(Schema.String),
});
export type ProviderControlsSnapshot = typeof ProviderControlsSnapshot.Type;
export class ProviderControlsError extends Schema.TaggedErrorClass<ProviderControlsError>()(
  "ProviderControlsError",
  { message: TrimmedNonEmptyString },
) {}
