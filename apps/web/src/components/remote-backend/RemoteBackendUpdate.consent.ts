import type {
  RemoteRuntimeUpdateAffectedWork,
  RemoteRuntimeUpdateConsentInput,
  RemoteRuntimeUpdateStatus,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import {
  CONSENTABLE_UPDATE_STATES,
  readRemoteRuntimeUpdateFailure,
} from "./RemoteBackendUpdate.logic";

/**
 * Interruption consent flow (D9). Consent is bound to the operation id plus the digest of the
 * affected-work list the user was shown. The flow only ever sends the digest of the list on
 * screen, only after an explicit confirm, and never resubmits on its own after `consent-stale`.
 */
export type InterruptReview =
  | { readonly phase: "closed" }
  | { readonly phase: "loading" }
  | {
      readonly phase: "review";
      readonly operationId: string;
      readonly digest: string;
      readonly work: ReadonlyArray<RemoteRuntimeUpdateAffectedWork>;
      /** The list changed since the user last saw it; they must confirm the new one. */
      readonly changed: boolean;
      readonly submitting: boolean;
    }
  | { readonly phase: "unavailable"; readonly message: string };

export const CLOSED_REVIEW: InterruptReview = { phase: "closed" };

/** Builds the review from a fresh status read; anything not consentable is explained instead. */
export function reviewFromStatus(
  status: RemoteRuntimeUpdateStatus,
  changed: boolean,
): InterruptReview {
  const operation = status.operation;
  if (!operation || !CONSENTABLE_UPDATE_STATES.includes(operation.state))
    return {
      phase: "unavailable",
      message: "The update is not waiting for running work any more. Nothing will be interrupted.",
    };
  if (operation.consent === "consumed")
    return { phase: "unavailable", message: "Interruption for this update was already used." };
  if (status.affectedWork.length === 0 || status.affectedWorkDigest === null)
    return {
      phase: "unavailable",
      message: "No running work blocks this update any more. It installs without interrupting.",
    };
  return {
    phase: "review",
    operationId: operation.operationId,
    digest: status.affectedWorkDigest,
    work: status.affectedWork,
    changed,
    submitting: false,
  };
}

/** The exact consent payload for the list on screen; null when nothing reviewable is shown. */
export function consentInputFromReview(
  review: InterruptReview,
): RemoteRuntimeUpdateConsentInput | null {
  if (review.phase !== "review" || review.submitting) return null;
  return { operationId: review.operationId, affectedWorkDigest: review.digest };
}

export type ConsentOutcome =
  /** Fetch the status again and show the new list for a fresh, explicit confirmation. */
  | { readonly kind: "reconfirm" }
  | { readonly kind: "settled"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export function classifyConsentError(error: unknown): ConsentOutcome {
  const typed = readRemoteRuntimeUpdateFailure(error);
  if (typed?.code === "consent-stale") return { kind: "reconfirm" };
  if (typed?.code === "consent-reused")
    return { kind: "settled", message: "Interruption for this update was already used." };
  if (typed?.message) return { kind: "failed", message: typed.message };
  return {
    kind: "failed",
    message:
      error instanceof Error && error.message ? error.message : "The backend did not answer.",
  };
}

/** A re-read after a stale consent marks the review changed so the dialog says so. */
export function reviewAfterStale(status: RemoteRuntimeUpdateStatus): InterruptReview {
  return reviewFromStatus(status, true);
}
