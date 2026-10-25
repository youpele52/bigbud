import { Schema } from "effect";

import { RuntimeItemId } from "../core/baseSchemas";

/** Activity kinds that describe one tool invocation's lifecycle. */
export const ToolLifecycleActivityKind = Schema.Literals([
  "tool.started",
  "tool.updated",
  "tool.completed",
]);
export type ToolLifecycleActivityKind = typeof ToolLifecycleActivityKind.Type;

/**
 * Payload of a `tool.started`, `tool.updated` or `tool.completed` thread activity.
 *
 * `itemId` is the runtime event's item ID. It pairs a `tool.started` with its
 * `tool.completed`, so recovery can tell which tool was in flight. It is optional: activities
 * written before it existed, and providers that send no item ID, decode without it. An
 * unmatched `tool.started` without an `itemId` counts as in flight.
 */
export const ToolActivityPayload = Schema.Struct({
  itemType: Schema.String,
  itemId: Schema.optional(RuntimeItemId),
  status: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type ToolActivityPayload = typeof ToolActivityPayload.Type;
