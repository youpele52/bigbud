import type { MobileCommandReceiptSourceValue } from "./mobileCommandReceiptSource";
import type { ClientOrchestrationCommand } from "@bigbud/contracts";
import type { OrchestrationCommandRejectionReason } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

export type MobileCommandDeliveryStatus =
  | "idle"
  | "pending"
  | "accepted"
  | "rejected"
  | "uncertain"
  | "reconciling";

export interface MobileCommandDeliveryOperation {
  readonly command: ClientOrchestrationCommand;
  readonly submittedRevision: number;
  readonly submittedAt: string;
  readonly deadlineAt: number;
  readonly receiptSource?: MobileCommandReceiptSourceValue;
}

export interface MobileCommandDeliveryState {
  readonly status: MobileCommandDeliveryStatus;
  readonly operation: MobileCommandDeliveryOperation | null;
  readonly rejectionReason?: OrchestrationCommandRejectionReason;
  /**
   * Set when a delivery check found no record of the command on the server.
   * Only then may the user resend it, with the same command ID.
   */
  readonly outcomeUnknown?: true;
}

export type MobileCommandOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: OrchestrationCommandRejectionReason }
  | { readonly status: "unknown" };

export const MOBILE_COMMAND_DEADLINE_MS = 15_000;

export function createMobileCommandDeliveryState(
  submitted:
    | (MobileCommandDeliveryOperation & {
        readonly status: MobileCommandDeliveryStatus;
        readonly rejectionReason?: OrchestrationCommandRejectionReason;
      })
    | null,
): MobileCommandDeliveryState {
  if (!submitted) return { status: "idle", operation: null };
  // A page refresh cannot prove that a pending dispatch was not accepted. Keep
  // the exact operation and make the user reconcile it explicitly.
  const status =
    submitted.status === "pending" || submitted.status === "reconciling"
      ? "uncertain"
      : submitted.status;
  return {
    status,
    operation: {
      command: submitted.command,
      submittedRevision: submitted.submittedRevision,
      submittedAt: submitted.submittedAt,
      deadlineAt: submitted.deadlineAt,
      ...(submitted.receiptSource ? { receiptSource: submitted.receiptSource } : {}),
    },
    ...(submitted.rejectionReason ? { rejectionReason: submitted.rejectionReason } : {}),
  };
}

export function beginMobileCommandDelivery(
  state: MobileCommandDeliveryState,
  operation: MobileCommandDeliveryOperation,
): MobileCommandDeliveryState | null {
  if (
    state.status === "pending" ||
    state.status === "reconciling" ||
    state.status === "uncertain"
  ) {
    return null;
  }
  return { status: "pending", operation };
}

export function settleMobileCommandAccepted(
  state: MobileCommandDeliveryState,
): MobileCommandDeliveryState {
  return { status: "accepted", operation: state.operation };
}

export function settleMobileCommandRejected(
  state: MobileCommandDeliveryState,
  reason: OrchestrationCommandRejectionReason = "other",
): MobileCommandDeliveryState {
  return { status: "rejected", operation: state.operation, rejectionReason: reason };
}

export function markMobileCommandUncertain(
  state: MobileCommandDeliveryState,
): MobileCommandDeliveryState {
  return { status: "uncertain", operation: state.operation };
}

export function beginMobileCommandReconciliation(
  state: MobileCommandDeliveryState,
): MobileCommandDeliveryState | null {
  return state.status === "uncertain" && state.operation && !state.operation.receiptSource
    ? { status: "reconciling", operation: state.operation }
    : null;
}

export function settleMobileCommandOutcome(
  state: MobileCommandDeliveryState,
  outcome: MobileCommandOutcome,
): MobileCommandDeliveryState {
  if (outcome.status === "accepted") return settleMobileCommandAccepted(state);
  if (outcome.status === "rejected") return settleMobileCommandRejected(state, outcome.reason);
  return { ...markMobileCommandUncertain(state), outcomeUnknown: true };
}
