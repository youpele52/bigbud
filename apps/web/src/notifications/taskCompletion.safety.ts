import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { Thread } from "../models/types";
import { mergeNotificationTasks } from "./taskCompletion.tasks";
import { selectLatestProposedPlan } from "../logic/session/session.timeline.logic";

/** Keep bounded summary safety evidence current without hydrating a transcript. */
export function observeNotificationSafety(
  previous: Thread,
  next: Thread,
  event: OrchestrationEvent,
): Thread {
  const safety = previous.notificationSafety ?? {
    turnId: previous.latestTurn?.turnId ?? null,
    tasks: previous.providerAgents?.slice(-100) ?? [],
    childThreadIds: [],
    childTurns: [],
    pendingRequestIds: [],
    queuedPromptIds: previous.queuedPrompts?.slice(0, 100).map((prompt) => prompt.id) ?? [],
    overflow:
      (previous.providerAgents?.length ?? 0) >= 100 || (previous.queuedPrompts?.length ?? 0) >= 100,
    pendingStartMessageId: null,
    pendingFlush: null,
    hasActionablePlan: false,
  };
  let pendingRequestIds = safety.pendingRequestIds;
  let queuedPromptIds = safety.queuedPromptIds;
  if (event.type === "thread.activity-appended") {
    const activity = event.payload.activity;
    const payload = activity.payload as { requestId?: unknown } | null;
    if (
      typeof payload?.requestId === "string" &&
      (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved")
    ) {
      pendingRequestIds = pendingRequestIds.filter((id) => id !== payload.requestId);
    }
  }
  if (event.type === "thread.queued-prompt-removed") {
    queuedPromptIds = queuedPromptIds.filter((id) => id !== event.payload.messageId);
  }
  if (event.type === "thread.queued-prompts-flushed") {
    queuedPromptIds = queuedPromptIds.filter((id) => !event.payload.messageIds.includes(id));
  }
  let pendingStartMessageId = safety.pendingStartMessageId ?? null;
  let pendingFlush = safety.pendingFlush ?? null;
  if (event.type === "thread.turn-start-requested") pendingStartMessageId = event.payload.messageId;
  if (
    (event.type === "thread.session-set" &&
      event.payload.session.status === "running" &&
      next.session !== previous.session &&
      next.session?.orchestrationStatus === "running") ||
    (event.type === "thread.turn-start-failed" &&
      (event.payload.messageId == null || event.payload.messageId === pendingStartMessageId)) ||
    (event.type === "thread.prompt-queued" && event.payload.prompt.id === pendingStartMessageId)
  )
    pendingStartMessageId = null;
  if (event.type === "thread.turn-interrupt-requested" && event.payload.pendingFlushIntent)
    pendingFlush = event.payload.pendingFlushIntent;
  if (
    (event.type === "thread.queued-prompt-flush-cancelled" &&
      event.payload.intentId === pendingFlush?.intentId) ||
    (event.type === "thread.queued-prompts-flushed" &&
      pendingFlush &&
      pendingFlush.queuedPromptIds.length === event.payload.messageIds.length &&
      pendingFlush.queuedPromptIds.every((id, i) => id === event.payload.messageIds[i]))
  )
    pendingFlush = null;
  const newTurn = next.latestTurn?.turnId !== safety.turnId;
  let childThreadIds = newTurn ? [] : safety.childThreadIds;
  let childTurns = newTurn ? [] : (safety.childTurns ?? []);
  if (event.type === "thread.activity-appended") {
    const activity = event.payload.activity;
    const childId = (activity.payload as { childThreadId?: unknown } | null)?.childThreadId;
    if (
      activity.kind === "delegation.child-linked" &&
      typeof childId === "string" &&
      next.latestTurn &&
      (activity.turnId === next.latestTurn.turnId ||
        (activity.turnId == null && activity.createdAt >= next.latestTurn.requestedAt)) &&
      !childThreadIds.includes(ThreadId.makeUnsafe(childId))
    ) {
      const threadId = ThreadId.makeUnsafe(childId);
      childThreadIds = [...childThreadIds, threadId].slice(0, 100);
      // Only the submitted request's native acceptance can resolve this link.
      const requestId = (activity.payload as { requestMessageId?: unknown } | null)
        ?.requestMessageId;
      childTurns = [
        ...childTurns,
        {
          threadId,
          turnId: null,
          sessionEpoch: null,
          requestMessageId: typeof requestId === "string" ? MessageId.makeUnsafe(requestId) : null,
        },
      ].slice(0, 100);
    }
  }
  let tasks = newTurn ? [] : safety.tasks;
  if (event.type === "thread.task-upserted" && event.payload.task.kind === "providerSubagent") {
    tasks = mergeNotificationTasks(tasks, [event.payload.task]).slice(-100);
  }
  if (event.type === "thread.task-removed") {
    // Unsuccessful disappearance remains blocked by the observation latch.
    tasks = tasks.filter((task) => task.id !== event.payload.taskId);
  }
  const plans = [...next.proposedPlans, ...(safety.selectedPlan ? [safety.selectedPlan] : [])];
  if (event.type === "thread.proposed-plan-upserted") plans.unshift(event.payload.proposedPlan);
  const byId = new Map<string, (typeof plans)[number]>();
  for (const plan of plans) {
    const prior = byId.get(plan.id);
    if (!prior || plan.updatedAt > prior.updatedAt) byId.set(plan.id, plan);
  }
  const selectedPlan = selectLatestProposedPlan([...byId.values()], next.latestTurn?.turnId);
  return {
    ...next,
    notificationSafetySequence: Math.max(previous.notificationSafetySequence ?? 0, event.sequence),
    notificationSafety: {
      ...safety,
      turnId: next.latestTurn?.turnId ?? null,
      tasks,
      childThreadIds,
      childTurns,
      pendingRequestIds,
      queuedPromptIds,
      pendingStartMessageId,
      pendingFlush: pendingFlush
        ? { ...pendingFlush, queuedPromptIds: pendingFlush.queuedPromptIds.slice(0, 100) }
        : null,
      selectedPlan,
      // Legacy boolean-only summaries cannot be cleared by an unrelated implementation.
      hasActionablePlan:
        safety.selectedPlan === undefined && safety.hasActionablePlan
          ? true
          : selectedPlan != null && selectedPlan.implementedAt == null,
      // Reset run-scoped uncertainty, never a truncated thread-level request/queue list.
      overflow:
        (newTurn
          ? safety.pendingRequestIds.length >= 100 || safety.queuedPromptIds.length >= 100
          : safety.overflow) ||
        tasks.length >= 100 ||
        childThreadIds.length >= 100 ||
        (pendingFlush?.queuedPromptIds.length ?? 0) >= 100,
    },
  };
}
