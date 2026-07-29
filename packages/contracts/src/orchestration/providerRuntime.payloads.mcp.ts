import { Schema } from "effect";

import { McpServerStatusList } from "./providerRuntime.mcp";
import { TrimmedNonEmptyStringSchema } from "./providerRuntime.primitives";

export const McpStatusUpdatedPayload = Schema.Struct({
  status: McpServerStatusList,
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

export const McpOauthCompletedPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type McpOauthCompletedPayload = typeof McpOauthCompletedPayload.Type;
