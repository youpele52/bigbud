import { isTrustedRemoteExecutablePath } from "@bigbud/shared/remoteExecutablePath";

/**
 * The single trust rule lives in `@bigbud/shared/remoteExecutablePath` so the
 * web settings form validates `remoteBinaryPath` exactly as the owner does.
 *
 * @module sshOwnerRemotePath
 */
export { isTrustedRemoteExecutablePath };

/**
 * The owner's OpenCode v2 executable binding. `binaryPath` is an explicit
 * remote override (`providers.opencodeV2.remoteBinaryPath`); when it is absent
 * the owner discovers the executable on each target. Neither form is ever a
 * request operand.
 */
export interface OpencodeV2ServiceBinding {
  readonly binaryPath?: string;
}

/**
 * Local identity for a discovering binding. It only lets the server match a
 * lease to its owner binding; it is never sent to the owner or executed.
 */
export const OPENCODE_V2_REMOTE_DISCOVERY = "/.bigbud-owner-discovery/opencode";

export const opencodeV2BindingIdentity = (binding: OpencodeV2ServiceBinding): string =>
  binding.binaryPath ?? OPENCODE_V2_REMOTE_DISCOVERY;

/** Owner argv for the binding: an explicit path, or discovery on each target. */
export const opencodeV2BindingArgs = (binding: OpencodeV2ServiceBinding): string[] =>
  binding.binaryPath === undefined
    ? ["--opencode-v2-discover"]
    : ["--opencode-v2-service", binding.binaryPath];
