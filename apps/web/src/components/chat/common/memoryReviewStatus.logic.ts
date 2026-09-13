import type { OrchestrationThreadActivity } from "@bigbud/contracts";

import { compareActivitiesByOrder } from "~/logic/session/session.activity.logic";

const MEMORY_REVIEW_STARTED = "learning.memory.started";
const MEMORY_REVIEW_ENDINGS = new Set([
  "learning.memory.updated",
  "learning.memory.unchanged",
  "learning.memory.retrying",
  "learning.memory.rejected",
  "learning.memory.failed",
  "learning.memory.interrupted",
]);

export interface MemoryReviewAttempt {
  readonly jobId: string;
  readonly attempt: number;
  readonly expiresAt: string;
  readonly startedAt: string;
}

export function shouldShowMemoryReviewStatus(input: {
  readonly memoryReviewing: boolean;
  readonly isWorking: boolean;
  readonly isCompacting: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasUnconfirmedProvider: boolean;
}): boolean {
  return (
    input.memoryReviewing &&
    !input.isWorking &&
    !input.isCompacting &&
    !input.hasPendingApproval &&
    !input.hasPendingUserInput &&
    !input.hasUnconfirmedProvider
  );
}

interface MemoryReviewIdentity {
  readonly jobId: string;
  readonly attempt: number;
}

function readIdentity(activity: OrchestrationThreadActivity): MemoryReviewIdentity | null {
  if (!activity.payload || typeof activity.payload !== "object") return null;
  const payload = activity.payload as Record<string, unknown>;
  if (typeof payload.jobId !== "string" || payload.jobId.trim().length === 0) return null;
  if (typeof payload.attempt !== "number" || !Number.isInteger(payload.attempt)) return null;
  if (payload.attempt < 1) return null;
  return { jobId: payload.jobId, attempt: payload.attempt };
}

function identityKey(identity: MemoryReviewIdentity): string {
  return `${identity.jobId}:${identity.attempt}`;
}

function readExpiry(activity: OrchestrationThreadActivity): string | null {
  if (!activity.payload || typeof activity.payload !== "object") return null;
  const expiresAt = (activity.payload as Record<string, unknown>).expiresAt;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  if (Date.parse(expiresAt) <= Date.parse(activity.createdAt)) return null;
  return expiresAt;
}

/** Returns the newest unexpired memory review attempt that has not ended. */
export function deriveMemoryReviewAttempt(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  now = Date.now(),
): MemoryReviewAttempt | null {
  const active = new Map<string, MemoryReviewAttempt>();
  const ended = new Set<string>();

  for (const activity of [...activities].toSorted(compareActivitiesByOrder)) {
    if (activity.kind !== MEMORY_REVIEW_STARTED && !MEMORY_REVIEW_ENDINGS.has(activity.kind)) {
      continue;
    }
    const identity = readIdentity(activity);
    if (!identity) continue;
    const key = identityKey(identity);
    if (MEMORY_REVIEW_ENDINGS.has(activity.kind)) {
      ended.add(key);
      active.delete(key);
      continue;
    }
    if (ended.has(key) || active.has(key)) continue;
    const expiresAt = readExpiry(activity);
    if (!expiresAt || Date.parse(expiresAt) <= now) continue;
    active.set(key, {
      jobId: identity.jobId,
      attempt: identity.attempt,
      expiresAt,
      startedAt: activity.createdAt,
    });
  }

  return [...active.values()].at(-1) ?? null;
}
