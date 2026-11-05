import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Schema } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import { redactMcpText } from "../../providerMcp.ts";

export const MUSE_PROVIDER = "muse" as const;

// Effect renderers recursively print Error.cause. Native evidence must never
// enter that public chain, enumerable fields, or serialized error payloads.
const museFailureEvidence = new WeakMap<object, unknown>();

/** Internal native evidence for classification; never forward this value to diagnostics. */
export function getMuseFailureEvidence(error: unknown): unknown {
  return typeof error === "object" && error !== null ? museFailureEvidence.get(error) : undefined;
}

export const museValidationError = (
  operation: string,
  issue: string,
  failureClass?: TurnStartFailureClass,
) =>
  new ProviderAdapterValidationError({
    provider: MUSE_PROVIDER,
    operation,
    issue,
    ...(failureClass ? { failureClass } : {}),
  });

export const museRequestError = (
  method: string,
  detail: string,
  failureClass?: TurnStartFailureClass,
  evidence?: unknown,
) => {
  const error = new ProviderAdapterRequestError({
    provider: MUSE_PROVIDER,
    method,
    detail: describeMuseError(detail),
    ...(failureClass ? { failureClass } : {}),
  });
  museFailureEvidence.set(error, evidence);
  return error;
};

export const museProcessError = (
  threadId: string,
  detail: string,
  failureClass?: TurnStartFailureClass,
  evidence?: unknown,
) => {
  const error = new ProviderAdapterProcessError({
    provider: MUSE_PROVIDER,
    threadId,
    detail: describeMuseError(detail),
    ...(failureClass ? { failureClass } : {}),
  });
  museFailureEvidence.set(error, evidence);
  return error;
};

/** Bounded, redacted one-line description of an unknown native failure. Never includes account labels. */
export function describeMuseError(error: unknown): string {
  let detail: string;
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; detail?: unknown };
    detail =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : typeof record.detail === "string"
          ? record.detail
          : "Unknown Muse failure";
  } else detail = String(error);
  return redactMcpText(detail)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-account]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Public typed boundary with sanitized detail; original evidence is retained only privately. */
export function mapMuseRequestError(
  method: string,
  cause: unknown,
  failureClass?: TurnStartFailureClass,
) {
  return museRequestError(method, describeMuseError(cause), failureClass, cause);
}

/** Preserve deliberate input validation, never cast an unknown throw into the adapter union. */
export function mapMuseValidationError(operation: string, cause: unknown) {
  return Schema.is(ProviderAdapterValidationError)(cause)
    ? cause
    : mapMuseRequestError(operation, cause, "invalid-request");
}

/** MSP error kind carried by the SDK's MspError, when present. */
export function museErrorKind(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = (error as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : undefined;
  }
  return undefined;
}

/**
 * A proven native refusal is an authoritative typed rejection (the host
 * decoded and rejected the command before admission). Timeouts, transport
 * loss and backpressure are explicitly NOT refusals.
 */
export function isProvenNativeRefusal(error: unknown): boolean {
  const kind = museErrorKind(error);
  return kind === "commandRejected" || kind === "invalidParams" || kind === "notFound";
}

/**
 * Proof that Muse already applied a creation we are replaying: the stored
 * command ID was admitted earlier with a different payload (`commandId
 * payload conflict`) or the pre-minted session ID already exists
 * (`session_id_conflict`). Either way the native session exists and must be
 * resumed, never created again.
 */
export function isMuseCreationAlreadyApplied(error: unknown): boolean {
  if (museErrorKind(error) !== "commandRejected") return false;
  const reason = (error as { data?: { reason?: unknown } }).data?.reason;
  if (reason === "session_id_conflict") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /commandId payload conflict|session_id_conflict/i.test(message);
}
