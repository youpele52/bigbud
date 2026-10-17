import type {
  ApprovalRequestId,
  OrchestrationThreadActivity,
  ProviderRuntimeEvent,
} from "@bigbud/contracts";

/** Canonical approval projection shared by ingestion and inspection tests; intent is never abbreviated. */
export function approvalRuntimeEventToActivities(
  event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
  helpers: {
    toApprovalRequestId: (value: string | undefined) => ApprovalRequestId | undefined;
    requestKindFromCanonicalRequestType: (
      value: string | undefined,
    ) => "browser" | "command" | "file-read" | "file-change" | undefined;
    truncateDetail: (value: string) => string;
  },
): ReadonlyArray<OrchestrationThreadActivity> {
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
        ...(event.payload.executionIntent
          ? { executionIntent: event.payload.executionIntent }
          : {}),
        ...(event.payload.detail ? { detail: helpers.truncateDetail(event.payload.detail) } : {}),
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
      turnId: event.turnId ?? null,
    },
  ];
}
