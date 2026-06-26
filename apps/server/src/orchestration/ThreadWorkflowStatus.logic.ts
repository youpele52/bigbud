import {
  ApprovalRequestId,
  type OrchestrationLatestTurn,
  type OrchestrationProposedPlan,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@bigbud/contracts";

export type ThreadWorkflowStatusLabel =
  | "archived"
  | "awaiting_approval"
  | "awaiting_input"
  | "compacting"
  | "connecting"
  | "error"
  | "idle"
  | "plan_ready"
  | "working"
  | "workflow_complete";

export interface ThreadWorkflowStatusSnapshot {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly workflowStatus: ThreadWorkflowStatusLabel;
  readonly isAgentActive: boolean;
  readonly isWorkflowComplete: boolean;
  readonly sessionStatus: OrchestrationSession["status"] | null;
  readonly latestTurnState: OrchestrationLatestTurn["state"] | null;
  readonly latestTurnCompletedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly lastAssistantExcerpt: string | null;
  readonly updatedAt: string;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.id.localeCompare(right.id);
}

function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<{ readonly requestId: ApprovalRequestId }> {
  const openByRequestId = new Map<ApprovalRequestId, { readonly requestId: ApprovalRequestId }>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "approval.requested" && requestId) {
      openByRequestId.set(requestId, { requestId });
      continue;
    }

    if (
      requestId &&
      (activity.kind === "approval.resolved" ||
        activity.kind === "provider.approval.respond.failed")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()];
}

function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<{ readonly requestId: ApprovalRequestId }> {
  const openByRequestId = new Map<ApprovalRequestId, { readonly requestId: ApprovalRequestId }>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (
      activity.kind === "user-input.requested" &&
      requestId &&
      Array.isArray(payload?.questions)
    ) {
      openByRequestId.set(requestId, { requestId });
      continue;
    }

    if (
      requestId &&
      (activity.kind === "user-input.resolved" ||
        activity.kind === "provider.user-input.respond.failed")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()];
}

function isSessionActivelyRunningTurn(
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "completedAt"> | null,
  session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null,
): boolean {
  if (!session || session.status !== "running") return false;
  if (!latestTurn) return true;

  const activeTurnId = session.activeTurnId;
  if (activeTurnId === null) {
    return latestTurn.completedAt === null;
  }
  if (latestTurn.turnId !== activeTurnId) {
    return true;
  }
  return latestTurn.completedAt === null;
}

function isLatestTurnSettled(
  latestTurn: OrchestrationLatestTurn | null,
  session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null,
): boolean {
  if (latestTurn === null) return true;
  if (!latestTurn.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  return !isSessionActivelyRunningTurn(latestTurn, session);
}

function isSessionCompacting(
  session: Pick<OrchestrationSession, "status" | "reason"> | null,
): boolean {
  return session?.status === "running" && session.reason === "context.compacting";
}

function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
  latestTurnId: OrchestrationLatestTurn["turnId"] | null,
): OrchestrationProposedPlan | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return matchingTurnPlan;
    }
  }

  return (
    [...proposedPlans]
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1) ?? null
  );
}

function hasActionableProposedPlan(
  proposedPlan: Pick<OrchestrationProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

function excerptAssistantMessage(messages: OrchestrationThread["messages"]): string | null {
  const assistantMessage = [...messages]
    .toReversed()
    .find(
      (message) =>
        message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
    );
  if (!assistantMessage) {
    return null;
  }
  const trimmed = assistantMessage.text.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

export function resolveThreadWorkflowStatus(
  thread: OrchestrationThread,
): ThreadWorkflowStatusSnapshot {
  const hasPendingApprovals = derivePendingApprovals(thread.activities).length > 0;
  const hasPendingUserInput = derivePendingUserInputs(thread.activities).length > 0;
  const latestProposedPlan = findLatestProposedPlan(
    thread.proposedPlans,
    thread.latestTurn?.turnId ?? null,
  );
  const actionableProposedPlan = hasActionableProposedPlan(latestProposedPlan);
  const session = thread.session;
  const latestTurn = thread.latestTurn;

  let workflowStatus: ThreadWorkflowStatusLabel = "idle";

  if (thread.archivedAt !== null) {
    workflowStatus = "archived";
  } else if (session?.status === "error" || latestTurn?.state === "error") {
    workflowStatus = "error";
  } else if (hasPendingApprovals) {
    workflowStatus = "awaiting_approval";
  } else if (hasPendingUserInput) {
    workflowStatus = "awaiting_input";
  } else if (session?.status === "starting") {
    workflowStatus = "connecting";
  } else if (session?.status === "running") {
    workflowStatus = isSessionCompacting(session) ? "compacting" : "working";
  } else if (
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(latestTurn, session) &&
    actionableProposedPlan
  ) {
    workflowStatus = "plan_ready";
  } else if (
    latestTurn?.state === "completed" &&
    isLatestTurnSettled(latestTurn, session) &&
    !hasPendingApprovals &&
    !hasPendingUserInput &&
    !actionableProposedPlan
  ) {
    workflowStatus = "workflow_complete";
  }

  const isAgentActive =
    workflowStatus === "working" ||
    workflowStatus === "compacting" ||
    workflowStatus === "connecting";

  return {
    threadId: thread.id,
    title: thread.title,
    workflowStatus,
    isAgentActive,
    isWorkflowComplete: workflowStatus === "workflow_complete",
    sessionStatus: session?.status ?? null,
    latestTurnState: latestTurn?.state ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    hasPendingApprovals,
    hasPendingUserInput,
    hasActionableProposedPlan: actionableProposedPlan,
    lastAssistantExcerpt: excerptAssistantMessage(thread.messages),
    updatedAt: thread.updatedAt,
  };
}

export function serializeThreadWorkflowStatusMarkdown(
  status: ThreadWorkflowStatusSnapshot,
): string {
  return [
    "### Thread status (at attach time)",
    `- Workflow status: ${status.workflowStatus}`,
    `- Agent active: ${status.isAgentActive ? "yes" : "no"}`,
    `- Workflow complete: ${status.isWorkflowComplete ? "yes" : "no"}`,
    `- Session status: ${status.sessionStatus ?? "none"}`,
    `- Latest turn state: ${status.latestTurnState ?? "none"}`,
    ...(status.latestTurnCompletedAt
      ? [`- Latest turn completed at: ${status.latestTurnCompletedAt}`]
      : []),
    `- Pending approvals: ${status.hasPendingApprovals ? "yes" : "no"}`,
    `- Pending user input: ${status.hasPendingUserInput ? "yes" : "no"}`,
    ...(status.lastAssistantExcerpt
      ? [`- Last assistant excerpt: ${status.lastAssistantExcerpt}`]
      : []),
    "",
    "Poll live status with the `get_thread_status` tool when coordinating work across threads.",
  ].join("\n");
}
