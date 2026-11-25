import { ServerListRemoteFoldersError } from "@bigbud/contracts/server/server.remoteFolders";

import {
  PickerProofStartupConfigError,
  PickerProofStartupRetirementError,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";
import {
  PickerProofOwnerError,
  type PickerProofOwnerErrorCode,
  type JumpFailure,
} from "./sshOwnerPickerProof.codec.wire.ts";

const ownerMessages: Partial<Record<PickerProofOwnerErrorCode, string>> = {
  ownerUnavailable: "The development SSH owner is no longer available.",
  operationDenied: "The development SSH owner denied this operation.",
  invalidOperands: "The development SSH owner rejected the supplied path or operation.",
  configUnsupported:
    "The SSH settings for this alias are unsupported or changed. Review the alias configuration before retrying.",
  routeUnavailable:
    "The SSH route helper for this alias is missing, substituted or not qualified. Only a qualified nc connector is supported.",
  trustRequired: "SSH host trust is not yet established. Retry to check the host key.",
  hostKeyChanged: "The SSH host key changed. The development SSH owner refused the connection.",
  trustStoreReadOnly: "The development SSH owner's host trust store is read-only.",
  authRequired:
    "The SSH server did not accept the configured identity. Check the login and key for this alias. This development picker cannot prompt for credentials.",
  keyboardInteractiveUnsupported:
    "This host only offers keyboard-interactive login, which is not supported. Use SSH key authentication.",
  ownerRetirementUnverified:
    "The previous SSH owner's process could not be verified. Stop bigbud and inspect the retirement record; use the explicit recovery command only when the recorded process is provably gone or its PID is provably reused.",
  windowsPasswordUnsupported: "Use an SSH key for this host.",
  sessionQuota:
    "The SSH server reached its session limit. Close another SSH session for this host and retry.",
  transportLost:
    "The SSH connection failed. Check that the configured host and port are reachable.",
  listFailed: "Failed to list remote folders.",
  listTimedOut: "The remote folder listing timed out.",
  listPathUnavailable: "The remote folder is unavailable.",
  listInvalidOutput: "The development SSH owner received an invalid remote folder listing.",
  staleGeneration: "The development SSH owner's target changed. Retry the operation.",
  storageUnavailable: "The development SSH owner's disconnect store is unavailable.",
  outcomeUnknown:
    "The development SSH owner could not confirm the operation's outcome. It was not retried.",
  versionIncompatible: "The development SSH owner uses an incompatible protocol version.",
  protocolError: "The development SSH owner returned an invalid response.",
};

/** Keep startup and subsequent owner failures distinct, without surfacing private startup operands. */
export class SshOwnerDevPickerError extends Error {
  constructor(
    readonly code:
      | "startupFailed"
      | "closed"
      | "unsupportedTarget"
      | "invalidChallenge"
      | "busy"
      | "ownerFailure"
      | "aliasChanged"
      | PickerProofOwnerErrorCode,
    message: string,
    cause?: PickerProofOwnerError,
  ) {
    super(message, { cause });
    this.name = "SshOwnerDevPickerError";
  }
}

export const invalidChallenge = () =>
  new SshOwnerDevPickerError(
    "invalidChallenge",
    "SSH host trust approval expired or is invalid. Check the host key again.",
  );

const jumpStageText = {
  admission: "checking the route settings and trust",
  forward: "opening the forward from the preceding hop",
  handshake: "connecting and verifying the server",
  listing: "listing folders",
  retirement: "closing the connection",
} as const satisfies Record<JumpFailure["stage"], string>;

function jumpFailureMessage(
  failure: JumpFailure,
  code: PickerProofOwnerErrorCode,
  message: string,
) {
  const location = failure.leg === 0 ? "SSH jump route" : `SSH route hop ${failure.leg}`;
  const detail =
    code === "trustRequired"
      ? "This route requires an approved host key for each hop before connecting."
      : message;
  return `${location} failed while ${jumpStageText[failure.stage]}. ${detail}`;
}

export function ownerFailure(error: unknown) {
  if (error instanceof PickerProofOwnerError) {
    const message =
      ownerMessages[error.code] ?? "The development SSH owner rejected this operation.";
    return new SshOwnerDevPickerError(
      error.code,
      error.jumpFailure ? jumpFailureMessage(error.jumpFailure, error.code, message) : message,
      error,
    );
  }
  return new SshOwnerDevPickerError("ownerFailure", "The development SSH owner operation failed.");
}

export function startupFailure(error: unknown) {
  if (error instanceof PickerProofStartupConfigError) {
    return new SshOwnerDevPickerError(error.code, error.message, error);
  }
  if (error instanceof PickerProofStartupRetirementError) {
    return new SshOwnerDevPickerError(error.code, error.message, error);
  }
  const cause =
    error instanceof PickerProofOwnerError ? new PickerProofOwnerError(error.code) : undefined;
  if (cause?.code === "configUnsupported") return ownerFailure(cause);
  return new SshOwnerDevPickerError(
    "startupFailed",
    cause === undefined
      ? "The development SSH owner failed to start."
      : `The development SSH owner failed to start (${cause.code}).`,
    cause,
  );
}

const folderCodes = {
  startupFailed: "sshOwnerUnavailable",
  ownerUnavailable: "sshOwnerUnavailable",
  versionIncompatible: "sshOwnerUnavailable",
  closed: "sshOwnerUnavailable",
  configUnsupported: "sshConfigUnsupported",
  aliasChanged: "sshAliasChanged",
  routeUnavailable: "sshRouteUnavailable",
  hostKeyChanged: "sshHostKeyChanged",
  trustStoreReadOnly: "sshTrustStoreReadOnly",
  authRequired: "sshAuthenticationRejected",
  keyboardInteractiveUnsupported: "sshKeyboardInteractiveUnsupported",
  ownerRetirementUnverified: "sshOwnerRetirementUnverified",
  windowsPasswordUnsupported: "sshWindowsPasswordUnsupported",
  sessionQuota: "sshSessionQuota",
  transportLost: "sshTransportLost",
} as const satisfies Partial<
  Record<SshOwnerDevPickerError["code"], ServerListRemoteFoldersError["code"]>
>;

/** Preserve actionable error categories across the authenticated dev picker RPC boundary. */
export function folderLookupFailure(cause: unknown) {
  const code =
    cause instanceof SshOwnerDevPickerError && Object.hasOwn(folderCodes, cause.code)
      ? folderCodes[cause.code as keyof typeof folderCodes]
      : undefined;
  return new ServerListRemoteFoldersError({
    message:
      cause instanceof Error && cause.message.trim()
        ? cause.message
        : "The development SSH picker operation failed.",
    ...(code ? { code } : {}),
    cause,
  });
}
