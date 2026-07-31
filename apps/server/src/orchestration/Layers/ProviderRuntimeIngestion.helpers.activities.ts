import type { OrchestrationThreadActivity, ProviderRuntimeEvent } from "@bigbud/contracts";

import { taskRuntimeEventToActivities } from "./ProviderRuntimeIngestion.helpers.activities.tasks.ts";
import { toolingRuntimeEventToActivities } from "./ProviderRuntimeIngestion.helpers.activities.tooling.ts";
import type { RuntimeEventActivityHelpers } from "./ProviderRuntimeIngestion.helpers.activities.types.ts";

export function runtimeEventToActivitiesFromHelpers(
  event: ProviderRuntimeEvent,
  helpers: RuntimeEventActivityHelpers,
): ReadonlyArray<OrchestrationThreadActivity> {
  const sequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();

  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") return [];
      const requestKind = helpers.requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "browser"
              ? "Browser approval requested"
              : requestKind === "command"
                ? "Command approval requested"
                : requestKind === "file-read"
                  ? "File-read approval requested"
                  : requestKind === "file-change"
                    ? "File-change approval requested"
                    : "Approval requested",
          payload: {
            requestId: helpers.toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail
              ? { detail: helpers.truncateDetail(event.payload.detail) }
              : {}),
            ...(typeof event.payload.autoApproveAfterMs === "number"
              ? { autoApproveAfterMs: event.payload.autoApproveAfterMs }
              : {}),
            ...(typeof event.payload.sessionApprovalAvailable === "boolean"
              ? { sessionApprovalAvailable: event.payload.sessionApprovalAvailable }
              : {}),
            ...(event.payload.sessionApprovalLabel
              ? { sessionApprovalLabel: helpers.truncateDetail(event.payload.sessionApprovalLabel) }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    }
    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") return [];
      const requestKind = helpers.requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: helpers.toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    }
    case "runtime.error": {
      const detail =
        event.payload.detail && typeof event.payload.detail === "object"
          ? JSON.stringify(event.payload.detail)
          : undefined;
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: helpers.truncateDetail(event.payload.message),
            ...(detail ? { detail: helpers.truncateDetail(detail, 400) } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    }
    case "runtime.warning":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: helpers.truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "turn.plan.updated":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "user-input.requested":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "user-input.resolved":
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "task.started":
    case "task.progress":
    case "task.completed":
    case "task.updated":
      return taskRuntimeEventToActivities(event, helpers, sequence);
    case "thread.state.changed":
      if (event.payload.state !== "compacted") return [];
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    case "thread.token-usage.updated": {
      const payload = helpers.buildContextWindowActivityPayload(event);
      if (!payload) return [];
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...sequence,
        },
      ];
    }
    case "item.updated":
    case "item.completed":
    case "item.started":
    case "hook.started":
    case "hook.progress":
    case "hook.completed":
    case "tool.progress":
    case "tool.summary":
    case "mcp.status.updated":
      return toolingRuntimeEventToActivities(event, helpers, sequence);
    default:
      return [];
  }
}
