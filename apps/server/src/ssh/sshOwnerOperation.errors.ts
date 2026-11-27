import { ServerListRemoteFoldersError } from "@bigbud/contracts/server/server.remoteFolders";

import { SshTargetAuthRequiredError } from "./sshTargetUnavailable.ts";
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
  ownerUnavailable: "The SSH owner is no longer available.",
  operationDenied: "The SSH owner denied this operation.",
  invalidOperands: "The SSH owner rejected the supplied path or operation.",
  configUnsupported:
    "The SSH settings for this alias are unsupported or changed. Review the alias configuration before retrying.",
  routeUnavailable:
    "The SSH route helper for this alias is missing, substituted or not qualified. Only a qualified nc connector is supported.",
  trustRequired: "SSH host trust is not yet established. Retry to check the host key.",
  hostKeyChanged: "The SSH host key changed. The SSH owner refused the connection.",
  trustStoreReadOnly: "The SSH owner's host trust store is read-only.",
  authRequired:
    "The SSH server did not accept the configured identity. Check the login and key for this alias.",
  keyboardInteractiveUnsupported:
    "This host only offers keyboard-interactive login, which is not supported. Use SSH key authentication.",
  ownerRetirementUnverified:
    "The previous SSH owner's process could not be verified. Stop bigbud and inspect the retirement record; use the explicit recovery command only when the recorded process is provably gone or its PID is provably reused.",
  windowsPasswordUnsupported: "Use an SSH key for this host.",
  credentialRequired:
    "This SSH target needs its password or key passphrase. Enter it in the app before retrying.",
  credentialRejected: "The SSH password or key passphrase was not accepted.",
  credentialAttemptsExhausted:
    "Too many incorrect SSH password or passphrase attempts. Disconnect and reconnect the target before trying again.",
  sessionQuota:
    "The SSH server reached its session limit. Close another SSH session for this host and retry.",
  transportLost:
    "The SSH connection failed. Check that the configured host and port are reachable.",
  listFailed: "Failed to list remote folders.",
  listTimedOut: "The remote folder listing timed out.",
  listPathUnavailable: "The remote folder is unavailable.",
  listInvalidOutput: "The SSH owner received an invalid remote folder listing.",
  staleGeneration: "The SSH owner's target changed. Retry the operation.",
  ownerArtifactMismatch:
    "The running SSH owner belongs to another bigbud installation or build and was not used. bigbud starts its own owner; if SSH stays unavailable, quit the other bigbud and retry.",
  storageUnavailable: "The SSH owner's disconnect store is unavailable.",
  outcomeUnknown: "The SSH owner could not confirm the operation's outcome. It was not retried.",
  versionIncompatible: "The SSH owner uses an incompatible protocol version.",
  protocolError: "The SSH owner returned an invalid response.",
};

/** Keep startup and subsequent owner failures distinct, without surfacing private startup operands. */
export class SshOwnerOperationError extends Error {
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
    this.name = "SshOwnerOperationError";
  }
}

export const invalidChallenge = () =>
  new SshOwnerOperationError(
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
  // The typed in-app credential prompt keeps its text and auth mode for the web.
  if (error instanceof SshTargetAuthRequiredError) return error;
  if (error instanceof PickerProofOwnerError) {
    const message = ownerMessages[error.code] ?? "The SSH owner rejected this operation.";
    return new SshOwnerOperationError(
      error.code,
      error.jumpFailure ? jumpFailureMessage(error.jumpFailure, error.code, message) : message,
      error,
    );
  }
  return new SshOwnerOperationError("ownerFailure", "The SSH owner operation failed.");
}

export function startupFailure(error: unknown) {
  if (error instanceof PickerProofStartupConfigError) {
    return new SshOwnerOperationError(error.code, error.message, error);
  }
  if (error instanceof PickerProofStartupRetirementError) {
    return new SshOwnerOperationError(error.code, error.message, error);
  }
  const cause =
    error instanceof PickerProofOwnerError ? new PickerProofOwnerError(error.code) : undefined;
  if (cause?.code === "configUnsupported") return ownerFailure(cause);
  return new SshOwnerOperationError(
    "startupFailed",
    cause === undefined
      ? "The SSH owner failed to start."
      : `The SSH owner failed to start (${cause.code}).`,
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
  Record<SshOwnerOperationError["code"], ServerListRemoteFoldersError["code"]>
>;

/** Preserve actionable error categories across the authenticated folder-picker RPC boundary. */
export function folderLookupFailure(cause: unknown) {
  const code =
    cause instanceof SshOwnerOperationError && Object.hasOwn(folderCodes, cause.code)
      ? folderCodes[cause.code as keyof typeof folderCodes]
      : undefined;
  return new ServerListRemoteFoldersError({
    message:
      cause instanceof Error && cause.message.trim()
        ? cause.message
        : "The SSH owner operation failed.",
    ...(code ? { code } : {}),
    cause,
  });
}
