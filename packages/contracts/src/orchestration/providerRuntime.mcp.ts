import { Schema } from "effect";

import { TrimmedNonEmptyString } from "../core/baseSchemas";

const BoundedMcpText = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

/** Provider-neutral lifecycle states for configured MCP servers. */
export const McpServerStatus = Schema.Literals([
  "pending",
  "connected",
  "needs-auth",
  "failed",
  "disabled",
]);
export type McpServerStatus = typeof McpServerStatus.Type;

/** Redacted, bounded MCP state suitable for runtime events and read models. */
export const McpServerStatusEntry = Schema.Struct({
  name: BoundedMcpText,
  status: McpServerStatus,
  message: Schema.optional(BoundedMcpText),
  version: Schema.optional(BoundedMcpText),
});
export type McpServerStatusEntry = typeof McpServerStatusEntry.Type;

export const McpServerStatusList = Schema.Array(McpServerStatusEntry);
export type McpServerStatusList = typeof McpServerStatusList.Type;
