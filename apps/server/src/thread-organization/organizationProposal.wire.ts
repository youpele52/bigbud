import * as Schema from "effect/Schema";
import {
  ThreadOrganizationNativeOperation as OrganizationOperation,
  type ThreadOrganizationNativeOutcome as OrganizationOperationOutcome,
} from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import type { OrganizationProposal, OrganizationReceipt } from "./organizationProtocol.ts";

const sections = ["", "needs-you", "present", "later", "done"] as const;
const reasons = [
  "",
  "attention",
  "active",
  "snooze-expired",
  "older",
  "idle",
  "target",
  "resolved",
] as const;

/** Decode at the TS trust boundary before preparing any durable operation. No enum fallbacks. */
export function organizationOperationFromProposal(
  owner: { backendNonce: string; generation: number },
  proposal: OrganizationProposal,
): OrganizationOperation {
  const from = sections[proposal.from];
  const destination = sections[proposal.destination];
  const reason = reasons[proposal.reason];
  if (
    !from ||
    !destination ||
    !reason ||
    !Number.isInteger(proposal.from) ||
    !Number.isInteger(proposal.destination) ||
    !Number.isInteger(proposal.reason)
  )
    throw new Error("invalid native organisation proposal enum");
  return Schema.decodeUnknownSync(OrganizationOperation)({
    operationId: proposal.operationId,
    occurrenceId: proposal.occurrenceId,
    attempt: proposal.attempt,
    threadId: proposal.threadId,
    ...owner,
    policyVersion: proposal.policyVersion,
    factVersion: proposal.factVersion,
    expectedRevision: proposal.expectedRevision,
    from,
    destination,
    reason,
    snoozeId: proposal.snoozeIdentity || null,
    inactivityCutoffMs: proposal.inactivityCutoffMs ?? null,
    createdAtMs: proposal.createdAtMs,
  });
}

export function organizationReceiptForOutcome(
  operationId: string,
  outcome: OrganizationOperationOutcome,
): OrganizationReceipt {
  return {
    operationId,
    outcome: outcome.status === "applied" ? 1 : outcome.status === "stale" ? 2 : 3,
    resultRevision: outcome.status === "applied" ? outcome.resultRevision : 0,
    resultSequence: outcome.status === "applied" ? outcome.resultSequence : 0,
    ...(outcome.status === "not-due" ? { retryNotBeforeMs: outcome.retryNotBeforeMs } : {}),
  };
}
