import type { OrchestrationThreadActivity } from "@bigbud/contracts";
import type { DelegationModelChoiceLinkedSummary } from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import type { ThreadDetailDelegatedChild } from "@bigbud/contracts/orchestration/orchestration.detail.ts";

import { readLinkedModelChoiceSummary } from "../../logic/session/session.activity.modelChoice.logic";
import type { DelegatedChildModelChoice, DelegatedChildSummary, Thread } from "../../models/types";

/** A record mirrored from the loaded tributary is newer than any linked summary. */
function keepModelChoice(
  existing: DelegatedChildSummary | undefined,
  summary: DelegationModelChoiceLinkedSummary | null,
): DelegatedChildModelChoice | undefined {
  if (existing?.modelChoice?.source === "tributary") return existing.modelChoice;
  return summary !== null ? { source: "linked", summary } : existing?.modelChoice;
}

/**
 * Detail hydration replaces the server's child summaries, which carry no model choice. Keep a
 * mirrored record, else read the summary from the trunk's own linked activities.
 */
export function hydrateDelegatedChildModelChoices(
  children: ReadonlyArray<ThreadDetailDelegatedChild>,
  previous: ReadonlyArray<DelegatedChildSummary> | undefined,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DelegatedChildSummary[] {
  const linked = new Map<string, DelegationModelChoiceLinkedSummary>();
  for (const activity of activities) {
    if (activity.kind !== "delegation.child-linked") continue;
    const payload = activity.payload as Record<string, unknown>;
    const summary = readLinkedModelChoiceSummary(payload);
    if (typeof payload.childThreadId === "string" && summary !== null) {
      linked.set(payload.childThreadId, summary);
    }
  }
  return children.map((child) => {
    const modelChoice = keepModelChoice(
      previous?.find((item) => item.threadId === child.threadId),
      linked.get(child.threadId) ?? null,
    );
    return modelChoice === undefined ? { ...child } : { ...child, modelChoice };
  });
}

export function applyDelegationLinkedActivity(
  thread: Thread,
  activity: OrchestrationThreadActivity,
): Thread {
  if (activity.kind !== "delegation.child-linked") return thread;
  const payload = activity.payload as Record<string, unknown>;
  if (
    typeof payload.childThreadId !== "string" ||
    typeof payload.childProjectId !== "string" ||
    typeof payload.childTitle !== "string"
  ) {
    return thread;
  }
  const modelChoice = keepModelChoice(
    thread.delegatedChildren?.find((item) => item.threadId === payload.childThreadId),
    readLinkedModelChoiceSummary(payload),
  );
  const child: DelegatedChildSummary = {
    threadId: payload.childThreadId as never,
    projectId: payload.childProjectId as never,
    title: payload.childTitle,
    workflowState: "idle" as const,
    updatedAt: activity.createdAt,
    ...(modelChoice !== undefined ? { modelChoice } : {}),
  };
  return {
    ...thread,
    delegatedChildren: [
      child,
      ...(thread.delegatedChildren ?? []).filter((item) => item.threadId !== child.threadId),
    ],
  };
}

export function removeDeletedDelegatedChildren(thread: Thread, deletedIds: ReadonlySet<string>) {
  if (!thread.delegatedChildren?.some((item) => deletedIds.has(item.threadId))) return thread;
  return {
    ...thread,
    delegatedChildren: thread.delegatedChildren.filter((item) => !deletedIds.has(item.threadId)),
  };
}
