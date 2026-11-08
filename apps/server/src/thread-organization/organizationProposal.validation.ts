import type { ThreadOrganizationNativeOperation as OrganizationOperation } from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import type { OrganizationPolicy, OrganizationRow } from "./organizationProtocol.ts";

export type OrganizationProposalValidation =
  | { status: "valid" }
  | { status: "stale" }
  | { status: "not-due"; retryNotBeforeMs: number };
const sections = { "needs-you": 1, present: 2, later: 3, done: 4 } as const;

/** Final acceptance gates, NOT a scheduler. Never selects another thread or destination.
 * Call with freshly observed authoritative facts inside serialized command acceptance.
 * A transport acknowledgement is not evidence that this function or persistence succeeded.
 */
export function validateOrganizationProposal(input: {
  operation: OrganizationOperation;
  owner: { backendNonce: string; generation: number };
  row: OrganizationRow | undefined;
  policy: OrganizationPolicy;
  nowMs: number;
  /** Startup/sleep/policy short-rule barrier owned by the TS observation boundary. */
  idleNotBeforeMs: number;
  /** Authoritative global count, not a filtered UI count. */
  presentCount: number;
}): OrganizationProposalValidation {
  const { operation: op, row, policy, nowMs } = input;
  const settings = policy.scheduling;
  const stale = { status: "stale" } as const;
  if (
    !row ||
    !settings ||
    row.inScope !== true ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    op.backendNonce !== input.owner.backendNonce ||
    op.generation !== input.owner.generation ||
    op.policyVersion !== policy.version ||
    row.threadId !== op.threadId ||
    row.factVersion !== op.factVersion ||
    row.organizationRevision !== op.expectedRevision ||
    row.section !== sections[op.from] ||
    row.snoozeIdentity !== (op.snoozeId ?? "") ||
    op.createdAtMs > nowMs ||
    row.manualAttentionWatermark === undefined
  )
    return stale;
  const wait = (deadline: number): OrganizationProposalValidation => {
    const retry = Math.max(deadline, op.createdAtMs + 1000);
    return Number.isSafeInteger(retry) && retry > nowMs
      ? { status: "not-due", retryNotBeforeMs: retry }
      : stale;
  };
  const manual = (row.manualUntilMs ?? 0) > nowMs;
  const snoozed = row.snoozeIdentity !== "";
  const newAttention = row.actionable && row.attentionWatermark > row.manualAttentionWatermark;
  const cleanup = op.reason === "idle" || op.reason === "older" || op.reason === "target";
  if (cleanup) {
    if (
      !row.eligible ||
      row.work !== 1 ||
      row.actionable ||
      snoozed ||
      row.inactivityAtMs === undefined
    )
      return stale;
    const protectedUntil = Math.max(
      row.manualUntilMs ?? 0,
      row.graceUntilMs ?? 0,
      row.engagedUntilMs ?? 0,
    );
    if (protectedUntil > nowMs) return wait(protectedUntil);
    if (op.reason === "target") {
      if (
        op.from !== "present" ||
        op.destination !== "later" ||
        op.inactivityCutoffMs !== null ||
        settings.presentTarget === undefined ||
        input.presentCount <= settings.presentTarget
      )
        return stale;
      if ((settings.targetNotBeforeMs ?? 0) > nowMs) return wait(settings.targetNotBeforeMs!);
    } else {
      const older = op.reason === "older";
      const enabled = older ? settings.olderEnabled : settings.idleEnabled;
      const timeout = older ? settings.olderTimeoutMs : settings.idleTimeoutMs;
      const destination = older ? 4 : settings.idleDestination;
      if (
        !enabled ||
        timeout <= 0 ||
        !Number.isSafeInteger(timeout) ||
        (op.from !== "present" && !(older && op.from === "later")) ||
        sections[op.destination] !== destination ||
        op.inactivityCutoffMs === null
      )
        return stale;
      const activityDeadline = row.inactivityAtMs + timeout;
      const barrier = older
        ? policy.olderPolicyChangedAtMs === undefined
          ? 0
          : policy.olderPolicyChangedAtMs + timeout
        : input.idleNotBeforeMs;
      const deadline = Math.max(activityDeadline, barrier);
      if (!Number.isSafeInteger(deadline)) return stale;
      if (deadline > nowMs) return wait(deadline);
      // The native proof cannot widen the authoritative age cutoff.
      if (op.inactivityCutoffMs > nowMs - timeout || row.inactivityAtMs > op.inactivityCutoffMs)
        return stale;
    }
    return { status: "valid" };
  }
  if (op.inactivityCutoffMs !== null) return stale;
  if (op.reason === "attention") {
    if (!row.actionable || op.destination !== "needs-you" || ((manual || snoozed) && !newAttention))
      return stale;
    return row.section !== 1 || manual || snoozed ? { status: "valid" } : stale;
  }
  if (manual) return wait(row.manualUntilMs!);
  if (op.reason === "snooze-expired") {
    if (!snoozed || row.snoozeUntilMs === undefined || op.destination !== "needs-you") return stale;
    return row.snoozeUntilMs > nowMs ? wait(row.snoozeUntilMs) : { status: "valid" };
  }
  if (op.reason === "resolved") {
    // Only automation's own Needs you placement returns; manual placement keeps its expiry
    // rule and a snooze reminder stays actionable. Work state is irrelevant (not cleanup).
    if (
      op.from !== "needs-you" ||
      op.destination !== "present" ||
      row.actionable ||
      snoozed ||
      row.automaticPlacement !== true
    )
      return stale;
    return { status: "valid" };
  }
  if (op.reason === "active") {
    if (
      row.work !== 2 ||
      row.actionable ||
      snoozed ||
      op.destination !== "present" ||
      op.from === "present"
    )
      return stale;
    return { status: "valid" };
  }
  return stale;
}
