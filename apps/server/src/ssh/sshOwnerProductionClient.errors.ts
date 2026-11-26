import * as Data from "effect/Data";

import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import {
  SshOwnerUnavailableError,
  type SshOwnerUnavailableReason,
} from "./sshOwnerStartupRefusal.ts";

/**
 * Typed failures of the production native owner client. Every failure keeps SSH
 * admission closed; none routes to a legacy executor.
 *
 * @module sshOwnerProductionClient.errors
 */

export type SshOwnerClientFailure =
  | "invalid-profile"
  | "unsupported-platform"
  | "attachment-invalid"
  | "attachment-refused"
  | "second-owner-refused"
  | "owner-start-failed"
  | "startup-timeout"
  | "version-incompatible"
  | "capability-missing"
  | "profile-mismatch"
  | "wire-limit-exceeded"
  | "wire-protocol-invalid"
  | "hydration-failed"
  | "hydration-disconnect-mismatch"
  | "hydration-alias-mismatch"
  | "hydration-retirement-unresolved"
  | "hydration-pane-unbound"
  | "retirement-unverifiable"
  | "pane-unrecoverable"
  | "owner-died";

export class SshOwnerClientError extends Data.TaggedError("SshOwnerClientError")<{
  readonly code: "sshOwnerClientError";
  readonly failure: SshOwnerClientFailure;
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(failure: SshOwnerClientFailure, message: string, cause?: unknown) {
    super({ code: "sshOwnerClientError", failure, message, ...(cause ? { cause } : {}) });
  }
}

const reasonByFailure: Record<SshOwnerClientFailure, SshOwnerUnavailableReason> = {
  "invalid-profile": "owner-profile-unavailable",
  "unsupported-platform": "owner-incompatible",
  "attachment-invalid": "owner-start-failed",
  "attachment-refused": "owner-second-instance",
  "second-owner-refused": "owner-second-instance",
  "owner-start-failed": "owner-start-failed",
  "startup-timeout": "owner-startup-timeout",
  "version-incompatible": "owner-version-incompatible",
  "capability-missing": "owner-capability-missing",
  "profile-mismatch": "owner-profile-mismatch",
  "wire-limit-exceeded": "owner-protocol-invalid",
  "wire-protocol-invalid": "owner-protocol-invalid",
  "hydration-failed": "hydration-failed",
  "hydration-disconnect-mismatch": "hydration-failed",
  "hydration-alias-mismatch": "hydration-failed",
  "hydration-retirement-unresolved": "hydration-failed",
  "hydration-pane-unbound": "hydration-failed",
  "retirement-unverifiable": "retirement-unverifiable",
  "pane-unrecoverable": "pane-unrecoverable",
  "owner-died": "owner-died",
};

/** Converts a client failure into the composition's typed unavailable result. */
export function sshOwnerUnavailableReason(
  failure: SshOwnerClientFailure,
): SshOwnerUnavailableReason {
  return reasonByFailure[failure];
}

/** Converts a client failure into the composition's typed unavailable result. */
export function toSshOwnerUnavailable(
  error: SshOwnerClientError,
  profile: SshOwnerProfile,
): SshOwnerUnavailableError {
  return new SshOwnerUnavailableError({
    code: "sshOwnerUnavailable",
    reason: reasonByFailure[error.failure],
    message: `${profile}: ${error.message}`,
  });
}

/** Classifies a shared proof-client error without inventing a second protocol. */
export function fromPickerProofError(error: unknown): SshOwnerClientError {
  if (error instanceof SshOwnerClientError) return error;
  const code =
    error instanceof Error && "code" in error ? (error as { readonly code: unknown }).code : "";
  const message = error instanceof Error ? error.message : "SSH owner startup failed.";
  if (code === "versionIncompatible") {
    return new SshOwnerClientError("version-incompatible", message, error);
  }
  if (code === "profileMismatch") {
    return new SshOwnerClientError(
      "profile-mismatch",
      "The SSH owner reported a different profile binding; refusing the session.",
      error,
    );
  }
  if (code === "protocolError") {
    return new SshOwnerClientError("wire-protocol-invalid", message, error);
  }
  if (code === "invalidOperands") {
    return new SshOwnerClientError("invalid-profile", message, error);
  }
  if (code === "ownerRetirementUnverified") {
    return new SshOwnerClientError(
      "retirement-unverifiable",
      "The SSH owner refused an unresolved retirement record; admission stays closed.",
      error,
    );
  }
  if (code === "paneUnrecoverable") {
    return new SshOwnerClientError(
      "pane-unrecoverable",
      "The SSH owner refused a malformed retained pane binding; admission stays closed.",
      error,
    );
  }
  return new SshOwnerClientError("owner-start-failed", message, error);
}
