import type {
  ThreadOrganization,
  ThreadOrganizationUpdatedPayload,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";

export function isDeliberateOrganizationChange(
  input: Pick<ThreadOrganizationUpdatedPayload, "source" | "reason">,
): boolean {
  return input.source === undefined
    ? !["idle", "snooze-expired"].includes(input.reason)
    : input.source === "deliberate";
}

/** Recorded times only. Legacy ambiguity preserves changedAt, never restore-time wall clock. */
export function organizationWithAge(
  current: ThreadOrganization,
  payload: ThreadOrganizationUpdatedPayload,
): ThreadOrganization {
  const previous = current.activityAt === undefined ? current.changedAt : current.activityAt;
  const next = isDeliberateOrganizationChange(payload) ? payload.organization.changedAt : null;
  const activityAt =
    previous === null ? next : next === null ? previous : previous > next ? previous : next;
  return {
    ...payload.organization,
    activityAt,
    ageProvenance:
      current.ageProvenance === undefined || current.ageProvenance === "pending"
        ? current.revision === 0
          ? "known"
          : "fallback"
        : current.ageProvenance,
  };
}

/** Shared snapshot/final-validation age; pending history must not authorize cleanup. */
export function effectiveOrganizationActivity(input: {
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly organization: ThreadOrganization;
  readonly completedAt?: string | null;
}): string | null {
  if (input.organization.ageProvenance === "pending" && input.organization.revision > 0)
    return null;
  return [
    input.createdAt,
    input.lastActivityAt,
    input.completedAt,
    input.organization.activityAt === undefined
      ? input.organization.changedAt
      : input.organization.activityAt,
  ]
    .filter((value): value is string => value != null)
    .reduce((latest, value) => (value > latest ? value : latest), input.createdAt);
}
