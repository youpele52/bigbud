import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  isToolLifecycleItemType,
} from "@bigbud/contracts";
import { toBoundedRedactedDisplayValue } from "@bigbud/shared/providerRuntime";

import type { RuntimeEventActivityHelpers } from "./ProviderRuntimeIngestion.helpers.activities.types.ts";
import type { RuntimeActivitySequence } from "./ProviderRuntimeIngestion.helpers.activities.tasks.ts";

/** Maps tool, hook, and MCP events to bounded activity shapes. */
export function toolingRuntimeEventToActivities(
  event: Extract<
    ProviderRuntimeEvent,
    | { type: "item.started" | "item.updated" | "item.completed" }
    | { type: "hook.started" | "hook.progress" | "hook.completed" }
    | { type: "tool.progress" | "tool.summary" | "mcp.status.updated" }
  >,
  helpers: RuntimeEventActivityHelpers,
  sequence: RuntimeActivitySequence,
): ReadonlyArray<OrchestrationThreadActivity> {
  switch (event.type) {
    case "item.updated":
      if (!isToolLifecycleItemType(event.payload.itemType)) return [];
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool updated",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail
              ? { detail: helpers.truncateDetail(event.payload.detail) }
              : {}),
            ...(event.payload.data !== undefined
              ? { data: toBoundedRedactedDisplayValue(event.payload.data) }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "item.completed":
      if (!isToolLifecycleItemType(event.payload.itemType)) return [];
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail
              ? { detail: helpers.truncateDetail(event.payload.detail) }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "item.started":
      if (!isToolLifecycleItemType(event.payload.itemType)) return [];
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: `${event.payload.title ?? "Tool"} started`,
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail
              ? { detail: helpers.truncateDetail(event.payload.detail) }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "hook.started":
      return [
        {
          id: EventId.makeUnsafe(`hook:${event.payload.hookId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "hook.updated",
          summary: `${event.payload.hookName} started`,
          payload: { hookId: event.payload.hookId, hookEvent: event.payload.hookEvent },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "hook.progress":
    case "hook.completed": {
      const output = event.payload.output ?? event.payload.stdout ?? event.payload.stderr;
      return [
        {
          id: EventId.makeUnsafe(`hook:${event.payload.hookId}`),
          createdAt: event.createdAt,
          tone:
            event.type === "hook.completed" && event.payload.outcome === "error" ? "error" : "info",
          kind: "hook.updated",
          summary: event.type === "hook.completed" ? "Hook completed" : "Hook running",
          payload: {
            hookId: event.payload.hookId,
            ...(output ? { detail: helpers.truncateDetail(output, 1_000) } : {}),
            ...(event.type === "hook.completed" ? { outcome: event.payload.outcome } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    }
    case "tool.progress": {
      const stableId = event.payload.toolUseId ?? event.eventId;
      return [
        {
          id: EventId.makeUnsafe(`tool-progress:${stableId}`),
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool running",
          payload: {
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.summary
              ? { detail: helpers.truncateDetail(event.payload.summary) }
              : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    }
    case "tool.summary":
      return [
        {
          id: EventId.makeUnsafe(
            event.payload.precedingToolUseIds?.at(-1)
              ? `tool-summary:${event.payload.precedingToolUseIds.at(-1)}`
              : String(event.eventId),
          ),
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.summary",
          summary: "Tool summary",
          payload: {
            detail: helpers.truncateDetail(event.payload.summary, 1_000),
            ...(event.payload.precedingToolUseIds
              ? {
                  precedingToolUseIds: toBoundedRedactedDisplayValue(
                    event.payload.precedingToolUseIds,
                  ),
                }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "mcp.status.updated":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "mcp.status.updated",
          summary: "MCP server status updated",
          payload: { status: toBoundedRedactedDisplayValue(event.payload.status) },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
  }
}
