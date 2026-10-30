import { CommandId, type OrchestrationCommand, type OrchestrationEvent } from "@bigbud/contracts";

import { stableThreadToolId } from "../../orchestration-tools/ThreadOrchestrationTools.origins.ts";
import type { PendingThreadSnooze } from "../../persistence/Services/ProjectionThreads.ts";

/** The sweep catches overdue snoozes after downtime, sleep, clock jumps, and lost timers. */
export const SNOOZE_SWEEP_INTERVAL_MS = 30_000;
export const SNOOZE_SWEEP_BATCH = 100;
export const SNOOZE_EXPIRE_ATTEMPTS = 3;

export type SnoozeEventEffect =
  | { readonly type: "schedule"; readonly snooze: PendingThreadSnooze }
  | { readonly type: "clear"; readonly threadId: PendingThreadSnooze["threadId"] };

/** How an accepted event changes the thread's snooze timer, if at all. */
export function snoozeEventEffect(event: OrchestrationEvent): SnoozeEventEffect | null {
  switch (event.type) {
    case "thread.organization-updated": {
      const { organization, threadId } = event.payload;
      return organization.snooze === null
        ? { type: "clear", threadId }
        : {
            type: "schedule",
            snooze: {
              threadId,
              snoozeId: organization.snooze.id,
              until: organization.snooze.until,
            },
          };
    }
    case "thread.deleted":
      return { type: "clear", threadId: event.payload.threadId };
    default:
      return null;
  }
}

/** Milliseconds until the deadline; never negative. */
export function snoozeDelayMs(until: string, nowMs: number): number {
  return Math.max(0, Date.parse(until) - nowMs);
}

export const isSnoozeDue = (until: string, nowMs: number) => Date.parse(until) <= nowMs;

/**
 * One command per attempt; its retries reuse it, so a retry never conflicts with its own receipt.
 * Repeated attempts for the same snooze are harmless: the first clears the snooze, so the rest
 * change nothing.
 */
export function expireSnoozeCommand(
  snooze: PendingThreadSnooze,
  createdAt: string,
): Extract<OrchestrationCommand, { type: "thread.organization.snooze.expire" }> {
  return {
    type: "thread.organization.snooze.expire",
    commandId: CommandId.makeUnsafe(
      stableThreadToolId("itutu-snooze-expire", JSON.stringify([snooze.snoozeId, createdAt])),
    ),
    threadId: snooze.threadId,
    snoozeId: snooze.snoozeId,
    createdAt,
  };
}
