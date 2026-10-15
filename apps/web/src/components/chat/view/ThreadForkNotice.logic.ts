import type { CommandId, ThreadId } from "@bigbud/contracts";
import {
  THREAD_FORKED_ACTIVITY_KIND,
  type ThreadForkCommand,
  type ThreadForkOrigin,
} from "@bigbud/contracts/orchestration/orchestration.fork.ts";

import type { Thread } from "../../../models/types/app.types";
import { TURN_START_FAILED_ACTIVITY_KIND } from "./ThreadRecoveryNotice.logic";

export interface ForkOriginNotice {
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
  readonly description: string;
}

/** Shown in a fork: names its source and how the source's pending message travelled. */
export function deriveForkOriginNotice(input: {
  readonly forkOrigin: ThreadForkOrigin | undefined;
  readonly parentThread: { readonly threadId: ThreadId; readonly title: string } | undefined;
}): ForkOriginNotice | null {
  const { forkOrigin, parentThread } = input;
  if (!forkOrigin || !parentThread) return null;
  const why =
    forkOrigin.reason === "manual"
      ? "This thread continues an earlier conversation."
      : "The earlier thread's provider session could not be resumed, so it continues here.";
  const pending =
    forkOrigin.pendingDelivery === "held"
      ? " Your last message may not have reached the provider; it is held in the queue until you send it."
      : forkOrigin.pendingDelivery === "sent"
        ? " Your last message was sent again here."
        : "";
  return {
    sourceThreadId: parentThread.threadId,
    sourceTitle: parentThread.title,
    description: `${why}${pending}`,
  };
}

export interface SourceForkNotice {
  readonly forkThreadId: ThreadId;
  readonly automatic: boolean;
}

const payloadOf = (activity: { readonly payload: unknown }) =>
  typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};

/** Shown in a source: links the newest fork made since the latest user message. */
export function deriveSourceForkNotice(
  thread: Pick<Thread, "messages" | "activities">,
): SourceForkNotice | null {
  const latestUserAt = thread.messages.findLast((message) => message.role === "user")?.createdAt;
  const forked = thread.activities.findLast(
    (activity) =>
      activity.kind === THREAD_FORKED_ACTIVITY_KIND &&
      (latestUserAt === undefined || activity.createdAt >= latestUserAt),
  );
  if (!forked) return null;
  const payload = payloadOf(forked);
  if (typeof payload.forkThreadId !== "string") return null;
  return {
    forkThreadId: payload.forkThreadId as ThreadId,
    automatic: payload.reason !== "manual",
  };
}

/** The manual "Continue in a new thread" command for the source's pending request. */
export function buildContinueInNewThreadCommand(input: {
  readonly thread: Pick<Thread, "id" | "turnStartRequest" | "activities">;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}): ThreadForkCommand {
  const request = input.thread.turnStartRequest ?? null;
  const failure =
    request === null
      ? undefined
      : input.thread.activities.findLast(
          (activity) =>
            activity.kind === TURN_START_FAILED_ACTIVITY_KIND &&
            activity.createdAt >= request.requestedAt,
        );
  return {
    type: "thread.fork",
    commandId: input.commandId,
    sourceThreadId: input.thread.id,
    threadId: input.threadId,
    reason: "manual",
    ...(failure ? { failureEventId: failure.id } : {}),
    ...(request && request.outcome !== "started" ? { pendingMessageId: request.messageId } : {}),
    createdAt: input.createdAt,
  };
}
