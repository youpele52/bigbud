/**
 * Pure selection rules for server-side thread forks (plan D16-D19): what is copied, under which
 * caps, with which new identities, and how the source's pending message travels.
 *
 * @module deciderThreads.fork.logic
 */
import { createHash } from "node:crypto";

import {
  EventId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
  type OrchestrationTask,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  RuntimeTaskId,
  type ThreadId,
} from "@bigbud/contracts";
import {
  THREAD_FORK_CAPS,
  THREAD_FORK_ORIGIN_ACTIVITY_KIND,
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCommand,
  type ThreadForkPendingDelivery,
} from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import {
  findOwnTurnStartFailure,
  TURN_START_FAILED_ACTIVITY_KIND,
} from "@bigbud/shared/threadFork";
import { PROMPT_SUGGESTION_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.promptSuggestion";

/** Recovery bookkeeping belongs to the source's failed session, never to the fork. */
const NON_COPIED_ACTIVITY_KINDS = new Set<string>([
  TURN_START_FAILED_ACTIVITY_KIND,
  "provider.session.recovery",
  THREAD_FORKED_ACTIVITY_KIND,
  THREAD_FORK_ORIGIN_ACTIVITY_KIND,
  // A fork starts without the source's prompt suggestion (Phase 7).
  PROMPT_SUGGESTION_ACTIVITY_KIND,
]);

/** Deterministic per (fork, source entity) so a redelivered command maps to the same rows. */
export function forkEntityId(kind: string, forkThreadId: ThreadId, sourceId: string): string {
  const digest = createHash("sha256").update(`${forkThreadId}\0${sourceId}`).digest("hex");
  return `${kind}-fork-${digest.slice(0, 32)}`;
}

function payloadField(activity: OrchestrationThreadActivity, key: string): unknown {
  const payload = activity.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/** A fork counts while its thread exists and is not deleted or being deleted. */
export function isForkThreadPresent(thread: OrchestrationThread | undefined): boolean {
  return thread !== undefined && thread.deletedAt === null && (thread.deletingAt ?? null) === null;
}

/** Fork thread ids named by the source's lineage activities (hydrated before deciding). */
export function forkLineageThreadIds(source: OrchestrationThread): ReadonlyArray<ThreadId> {
  return source.activities.flatMap((activity) => {
    const forkThreadId = payloadField(activity, "forkThreadId");
    return activity.kind === THREAD_FORKED_ACTIVITY_KIND && typeof forkThreadId === "string"
      ? [forkThreadId as ThreadId]
      : [];
  });
}

/**
 * True when this exact fork already happened (same fork id, or the same failure or pending
 * message forked into a thread that still exists). A deleted fork no longer counts, so the user
 * can continue that message again (D20).
 */
export function isForkAlreadyRecorded(input: {
  readonly readModel: OrchestrationReadModel;
  readonly source: OrchestrationThread;
  readonly command: ThreadForkCommand;
}): boolean {
  const { command, source } = input;
  const existing = input.readModel.threads.find((thread) => thread.id === command.threadId);
  if (existing?.forkOrigin !== undefined && existing.parentThread?.threadId === source.id) {
    return true;
  }
  return source.activities.some((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return false;
    const forkThreadId = payloadField(activity, "forkThreadId");
    const fork = input.readModel.threads.find((thread) => thread.id === forkThreadId);
    if (!isForkThreadPresent(fork)) return false;
    const failureEventId = payloadField(activity, "failureEventId");
    const pendingMessageId = payloadField(activity, "pendingMessageId");
    return (
      (command.failureEventId !== undefined && failureEventId === command.failureEventId) ||
      (command.pendingMessageId !== undefined && pendingMessageId === command.pendingMessageId)
    );
  });
}

/**
 * The latest turn's output is uncertain while it runs, or when it did not complete and was
 * requested for the pending (else latest) user message. A turn-start failure also marks an
 * earlier, already settled turn as `error`; that earlier turn stays certain.
 */
function uncertainTurnId(source: OrchestrationThread, pendingMessageId: MessageId | undefined) {
  const latest = source.latestTurn;
  if (latest === null || latest.state === "completed") return null;
  if (latest.state === "running") return latest.turnId;
  const anchor =
    source.messages.find((message) => message.id === pendingMessageId) ??
    source.messages.findLast((message) => message.role === "user");
  return anchor === undefined || latest.requestedAt >= anchor.createdAt ? latest.turnId : null;
}

/**
 * Settled history only: no pending message, no streaming output, nothing from an uncertain turn,
 * and no trailing unanswered user messages. Newest `THREAD_FORK_CAPS.messages` win.
 */
export function selectForkMessages(
  source: OrchestrationThread,
  pendingMessageId: MessageId | undefined,
): ReadonlyArray<OrchestrationMessage> {
  const uncertain = uncertainTurnId(source, pendingMessageId);
  const settled = source.messages.filter(
    (message) =>
      message.id !== pendingMessageId &&
      !message.streaming &&
      (uncertain === null || message.turnId !== uncertain),
  );
  let end = settled.length;
  while (end > 0 && settled[end - 1]?.role === "user") end--;
  return settled.slice(0, end).slice(-THREAD_FORK_CAPS.messages);
}

export function copyForkMessages(
  forkThreadId: ThreadId,
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  const ids = new Map(
    messages.map((message) => [
      message.id,
      MessageId.makeUnsafe(forkEntityId("message", forkThreadId, message.id)),
    ]),
  );
  return messages.map((message) => {
    const { replyTo, ...rest } = message;
    const replyId = replyTo ? ids.get(replyTo.messageId) : undefined;
    // Source turn ids do not exist in the fork.
    return Object.assign(rest, {
      id: ids.get(message.id) ?? message.id,
      turnId: null,
      ...(replyTo && replyId
        ? { replyTo: Object.assign({}, replyTo, { messageId: replyId }) }
        : {}),
    });
  });
}

/** Newest activities minus recovery bookkeeping; one slot stays free for the origin notice. */
export function copyForkActivities(
  forkThreadId: ThreadId,
  source: OrchestrationThread,
  pendingMessageId: MessageId | undefined,
): ReadonlyArray<OrchestrationThreadActivity> {
  const uncertain = uncertainTurnId(source, pendingMessageId);
  return source.activities
    .filter(
      (activity) =>
        !NON_COPIED_ACTIVITY_KINDS.has(activity.kind) &&
        (uncertain === null || activity.turnId !== uncertain),
    )
    .slice(-(THREAD_FORK_CAPS.activities - 1))
    .map(({ sequence: _sequence, ...activity }) =>
      Object.assign(activity, {
        id: EventId.makeUnsafe(forkEntityId("activity", forkThreadId, activity.id)),
        turnId: null,
      }),
    );
}

export function copyForkPlans(
  forkThreadId: ThreadId,
  source: OrchestrationThread,
): ReadonlyArray<OrchestrationProposedPlan> {
  return source.proposedPlans
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(-THREAD_FORK_CAPS.proposedPlans)
    .map((plan) =>
      Object.assign({}, plan, { id: forkEntityId("plan", forkThreadId, plan.id), turnId: null }),
    );
}

/** Task references are remapped inside the copied set and dropped when they point outside it. */
export function copyForkTasks(
  forkThreadId: ThreadId,
  source: OrchestrationThread,
): ReadonlyArray<OrchestrationTask> {
  const tasks = (source.tasks ?? []).slice(-THREAD_FORK_CAPS.tasks);
  const ids = new Map(
    tasks.map((task) => [
      task.id,
      RuntimeTaskId.makeUnsafe(forkEntityId("task", forkThreadId, task.id)),
    ]),
  );
  return tasks.map((task) => {
    const { parentTaskId, blockedBy, turnId: _turnId, ...rest } = task;
    const parent = parentTaskId ? ids.get(parentTaskId) : undefined;
    const blockers = blockedBy?.flatMap((id) => {
      const mapped = ids.get(id);
      return mapped ? [mapped] : [];
    });
    return Object.assign(rest, {
      id: ids.get(task.id) ?? task.id,
      activityFresh: false,
      ...(parent ? { parentTaskId: parent } : {}),
      ...(blockers && blockers.length > 0 ? { blockedBy: blockers } : {}),
    });
  });
}

/**
 * The pending message is sent in the fork only when its own turn-start failure proves it never
 * reached a provider (`session-dead`, classified before dispatch); otherwise it is held. Another
 * message's failure never decides it (a later `session-dead` must not resend an uncertain one).
 */
export function resolvePendingDelivery(
  source: OrchestrationThread,
  pending: OrchestrationMessage,
): ThreadForkPendingDelivery {
  const own = findOwnTurnStartFailure(source, pending.id);
  return own !== undefined && payloadField(own, "failureClass") === "session-dead"
    ? "sent"
    : "held";
}

/**
 * True when an earlier fork (now deleted, or the decider would have kept it) already received this
 * message. Sending it again may repeat its workspace changes, since forks share the worktree.
 */
export function wasPendingDeliveredBefore(
  source: OrchestrationThread,
  pendingMessageId: MessageId,
): boolean {
  return source.activities.some(
    (activity) =>
      activity.kind === THREAD_FORKED_ACTIVITY_KIND &&
      payloadField(activity, "pendingMessageId") === pendingMessageId &&
      payloadField(activity, "pendingDelivery") === "sent",
  );
}
