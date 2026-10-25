import type { CommandId, EventId, MessageId, ThreadId } from "@bigbud/contracts";
import {
  THREAD_FORK_ORIGIN_ACTIVITY_KIND,
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCommand,
  type ThreadForkOrigin,
} from "@bigbud/contracts/orchestration/orchestration.fork.ts";
import { findLiveAutomaticFork } from "@bigbud/shared/threadFork";

import type { Thread } from "../../../models/types/app.types";
import { deriveServerTurnFailure } from "./ThreadRecoveryNotice.failure";

const payloadOf = (activity: { readonly payload: unknown }) =>
  typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};

export interface ForkOriginNotice {
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
  readonly description: string;
  /** Amber when the message was sent again after an earlier, deleted fork received it. */
  readonly tone: "info" | "warning";
}

/**
 * Shown in a fork: names its source and how the source's pending message travelled. The fork's
 * `thread.fork-origin` activity keeps the delivery after a reload, and marks a repeated delivery.
 */
export function deriveForkOriginNotice(input: {
  readonly forkOrigin: ThreadForkOrigin | undefined;
  readonly parentThread: { readonly threadId: ThreadId; readonly title: string } | undefined;
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): ForkOriginNotice | null {
  const { forkOrigin, parentThread } = input;
  if (!forkOrigin || !parentThread) return null;
  const origin = input.activities.findLast(
    (activity) => activity.kind === THREAD_FORK_ORIGIN_ACTIVITY_KIND,
  );
  const lineage = origin ? payloadOf(origin) : {};
  const delivery = forkOrigin.pendingDelivery ?? lineage.pendingDelivery;
  const redelivered = delivery === "sent" && lineage.redelivered === true;
  const why =
    forkOrigin.reason === "manual"
      ? "This thread continues an earlier conversation."
      : "The earlier thread's provider session could not be resumed, so it continues here.";
  const pending = redelivered
    ? " Your last message was sent again here after an earlier fork received it; any workspace changes it made may be repeated."
    : delivery === "held"
      ? " Your last message may not have reached the provider; it is held in the queue until you send it."
      : delivery === "sent"
        ? " Your last message was sent again here."
        : "";
  return {
    sourceThreadId: parentThread.threadId,
    sourceTitle: parentThread.title,
    description: `${why}${pending}`,
    tone: redelivered ? "warning" : "info",
  };
}

/** A later never-admitted message the user may send to the source's existing fork (D20). */
export interface ForkCarry {
  readonly pendingMessageId: MessageId;
  readonly failureEventId: string;
}

export interface SourceForkNotice {
  readonly forkThreadId: ThreadId;
  readonly automatic: boolean;
  readonly carry: ForkCarry | null;
}

type LineageThread = Pick<Thread, "messages" | "activities">;

/** Only a failure that proves the message never reached a provider may follow the fork. */
function deriveForkCarry(thread: LineageThread): ForkCarry | null {
  const failure = deriveServerTurnFailure(thread);
  if (failure?.failureClass !== "session-dead") return null;
  const carried = thread.activities.some(
    (activity) =>
      activity.kind === THREAD_FORKED_ACTIVITY_KIND &&
      payloadOf(activity).pendingMessageId === failure.pendingMessageId,
  );
  return carried
    ? null
    : { pendingMessageId: failure.pendingMessageId, failureEventId: failure.failureEventId };
}

/**
 * Shown in a source: links the newest manual fork made since the latest user message (both on
 * the browser's command clock), else the automatic fork the source continued in while it stays
 * dead (one automatic fork, D20; decided by message order, not the server's fork timestamp).
 * Deleted or unknown forks are ignored, so the manual action comes back.
 */
export function deriveSourceForkNotice(
  thread: LineageThread,
  isForkPresent: (forkThreadId: string) => boolean,
): SourceForkNotice | null {
  const latestUserAt = thread.messages.findLast((message) => message.role === "user")?.createdAt;
  const manual = thread.activities.findLast((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return false;
    const payload = payloadOf(activity);
    return (
      payload.reason === "manual" &&
      typeof payload.forkThreadId === "string" &&
      isForkPresent(payload.forkThreadId) &&
      (latestUserAt === undefined || activity.createdAt >= latestUserAt)
    );
  });
  if (manual !== undefined) {
    return {
      forkThreadId: payloadOf(manual).forkThreadId as ThreadId,
      automatic: false,
      carry: null,
    };
  }
  const live = findLiveAutomaticFork(thread, isForkPresent);
  if (live === null) return null;
  return {
    forkThreadId: live.forkThreadId as ThreadId,
    automatic: true,
    carry: deriveForkCarry(thread),
  };
}

type ContinueSource = Pick<Thread, "id" | "turnStartRequest" | "messages" | "activities">;

/**
 * The message "Continue in a new thread" takes along. It comes from server state, so it survives a
 * reload; a live request still waiting supplies it before any failure exists.
 */
export function resolveContinuePendingMessageId(thread: ContinueSource): MessageId | undefined {
  const failure = deriveServerTurnFailure(thread);
  const request = thread.turnStartRequest;
  return (
    failure?.pendingMessageId ?? (request?.outcome === "pending" ? request.messageId : undefined)
  );
}

/** The manual "Continue in a new thread" command for the source's pending message and failure. */
export function buildContinueInNewThreadCommand(input: {
  readonly thread: ContinueSource;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}): ThreadForkCommand {
  const failure = deriveServerTurnFailure(input.thread);
  const pendingMessageId = resolveContinuePendingMessageId(input.thread);
  return {
    type: "thread.fork",
    commandId: input.commandId,
    sourceThreadId: input.thread.id,
    threadId: input.threadId,
    reason: "manual",
    ...(failure ? { failureEventId: failure.failureEventId as EventId } : {}),
    ...(pendingMessageId !== undefined ? { pendingMessageId } : {}),
    createdAt: input.createdAt,
  };
}

/** "Send this message to the continued thread": carry it into the existing fork (D20). */
export function buildCarryToContinuedThreadCommand(input: {
  readonly sourceThreadId: ThreadId;
  readonly forkThreadId: ThreadId;
  readonly carry: ForkCarry;
  readonly commandId: CommandId;
  readonly createdAt: string;
}): ThreadForkCommand {
  return {
    type: "thread.fork",
    commandId: input.commandId,
    sourceThreadId: input.sourceThreadId,
    threadId: input.forkThreadId,
    reason: "manual",
    failureEventId: input.carry.failureEventId as EventId,
    pendingMessageId: input.carry.pendingMessageId,
    createdAt: input.createdAt,
  };
}
