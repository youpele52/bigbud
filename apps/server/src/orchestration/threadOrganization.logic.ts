/**
 * Pure Ìtútù organization transitions. The decider records their results in
 * `thread.organization-updated`; projectors only apply recorded values.
 */
import type { OrchestrationThread } from "@bigbud/contracts";
import {
  DEFAULT_THREAD_ORGANIZATION,
  type ThreadOrganization,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

const MINUTE_MS = 60_000;

export function currentThreadOrganization(
  thread: Pick<OrchestrationThread, "organization">,
): ThreadOrganization {
  return thread.organization ?? DEFAULT_THREAD_ORGANIZATION;
}

/**
 * An explicit move always replaces a snooze, even when the destination is Later again. Moving to
 * Present again is an intentional refresh. Other same-state moves without a snooze change nothing.
 */
export function organizationAfterMove(
  current: ThreadOrganization,
  state: ThreadOrganizationState,
  occurredAt: string,
): ThreadOrganization | null {
  if (current.state === state && current.snooze === null && state !== "present") return null;
  return { state, revision: current.revision + 1, changedAt: occurredAt, snooze: null };
}

/** Snoozing puts the thread in Later until an absolute, server-calculated deadline. */
export function organizationAfterSnooze(
  current: ThreadOrganization,
  input: {
    readonly snoozeId: string;
    readonly durationMinutes: number;
    readonly occurredAt: string;
  },
): ThreadOrganization {
  const until = new Date(Date.parse(input.occurredAt) + input.durationMinutes * MINUTE_MS);
  return {
    state: "later",
    revision: current.revision + 1,
    changedAt: input.occurredAt,
    snooze: { id: input.snoozeId, until: until.toISOString() },
  };
}

/**
 * A snooze deadline brings the thread to Needs you, once. Anything that replaced or cleared that
 * snooze (a move, a re-snooze, archive, a new request) wins, as does a deadline not yet reached.
 */
export function organizationAfterSnoozeExpiry(
  current: ThreadOrganization,
  input: { readonly snoozeId: string; readonly occurredAt: string },
): ThreadOrganization | null {
  const snooze = current.snooze;
  if (snooze === null || snooze.id !== input.snoozeId) return null;
  if (Date.parse(snooze.until) > Date.parse(input.occurredAt)) return null;
  return {
    state: "needs-you",
    revision: current.revision + 1,
    changedAt: input.occurredAt,
    snooze: null,
  };
}

/** Archiving keeps the state but cancels a pending snooze so it can never fire later. */
export function organizationAfterArchive(
  current: ThreadOrganization,
  occurredAt: string,
): ThreadOrganization | null {
  if (current.snooze === null) return null;
  return { ...current, revision: current.revision + 1, changedAt: occurredAt, snooze: null };
}

/** An unarchived thread returns to Present without reviving an old snooze. */
export function organizationAfterUnarchive(
  current: ThreadOrganization,
  occurredAt: string,
): ThreadOrganization {
  return { state: "present", revision: current.revision + 1, changedAt: occurredAt, snooze: null };
}
