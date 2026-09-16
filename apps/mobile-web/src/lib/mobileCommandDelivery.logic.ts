import type { ClientOrchestrationCommand } from "@bigbud/contracts";

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
}

export interface MobileCommandDeliveryState {
  readonly status: MobileCommandDeliveryStatus;
  readonly operation: MobileCommandDeliveryOperation | null;
  readonly rejectionReason?: "thread_already_exists" | "other";
}

export type MobileCommandOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: "thread_already_exists" | "other" }
  | { readonly status: "unknown" };

export const MOBILE_COMMAND_DEADLINE_MS = 15_000;

export function createMobileCommandDeliveryState(
  submitted:
    | (MobileCommandDeliveryOperation & {
        readonly status: MobileCommandDeliveryStatus;
        readonly rejectionReason?: "thread_already_exists" | "other";
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
  reason: "thread_already_exists" | "other" = "other",
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
  return state.status === "uncertain" && state.operation
    ? { status: "reconciling", operation: state.operation }
    : null;
}

export function settleMobileCommandOutcome(
  state: MobileCommandDeliveryState,
  outcome: MobileCommandOutcome,
): MobileCommandDeliveryState {
  if (outcome.status === "accepted") return settleMobileCommandAccepted(state);
  if (outcome.status === "rejected") return settleMobileCommandRejected(state, outcome.reason);
  return markMobileCommandUncertain(state);
}
