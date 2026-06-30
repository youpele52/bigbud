import {
  type ApprovalRequestId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  type TurnId,
  isToolLifecycleItemType,
} from "@bigbud/contracts";

interface RuntimeEventActivityHelpers {
  readonly toTurnId: (value: TurnId | string | undefined) => TurnId | undefined;
  readonly toApprovalRequestId: (value: string | undefined) => ApprovalRequestId | undefined;
  readonly truncateDetail: (value: string, limit?: number) => string;
  readonly requestKindFromCanonicalRequestType: (
    requestType: string | undefined,
  ) => "browser" | "command" | "file-read" | "file-change" | undefined;
  readonly buildContextWindowActivityPayload: (
    event: ProviderRuntimeEvent,
  ) => ThreadTokenUsageSnapshot | undefined;
}

export function runtimeEventToActivitiesFromHelpers(
  event: ProviderRuntimeEvent,
  helpers: RuntimeEventActivityHelpers,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();

  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
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
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
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
          ...maybeSequence,
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
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
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
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
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
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
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
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
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
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: helpers.truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "thinking",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail: helpers.truncateDetail(event.payload.summary ?? event.payload.description),
            ...(event.payload.summary
              ? { summary: helpers.truncateDetail(event.payload.summary) }
              : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary
              ? { detail: helpers.truncateDetail(event.payload.summary) }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

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
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = helpers.buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
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
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: helpers.toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
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
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
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
          ...maybeSequence,
        },
      ];
    }

    default:
      return [];
  }
}
