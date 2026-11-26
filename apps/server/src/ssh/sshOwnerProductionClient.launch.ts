import { join } from "node:path";
import type { OpencodeV2ServiceBinding } from "./sshOwnerRemotePath.ts";
import type { DevOpencodeV2ServiceRefusal } from "./sshOwnerDevRuntime.providerServices.ts";

import {
  attachPickerProofOwner,
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
  type PickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import type { PickerProofSessionOptions } from "./sshOwnerPickerProof.client.session.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";
import {
  validateTargetDescriptor,
  type ProofTargetDescriptorInput,
} from "./sshOwnerPickerProof.codec.target.ts";
import {
  PickerProofStartupTimeoutError,
  PickerProofStartupConfigError,
  PickerProofStartupRetirementError,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";
import type { SshOwnerArtifact, SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import {
  absolutePath,
  ensurePrivateSshOwnerDirectory,
  MAX_SOCKET_BYTES,
  type SshOwnerAttachmentDescriptor,
} from "./sshOwnerProductionClient.attachment.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";
import { isTrustedRemoteExecutablePath } from "./sshOwnerRemotePath.ts";
import {
  deriveSshOwnerProfileBinding,
  type SshOwnerProfileBinding,
} from "./sshOwnerProductionProfile.ts";
import { SSH_OWNER_WIRE_LIMITS } from "./sshOwnerProductionClient.negotiate.ts";

/**
 * Fixed production launch facts for one initiating profile.
 *
 * The caller supplies the verified artifact facts and this profile binding; it
 * never supplies the owner executable, its argv or its environment. The
 * OpenSSH images are the owner's own allowlisted system paths. A production
 * owner starts with no target: each target arrives as a request descriptor.
 *
 * @module sshOwnerProductionClient.launch
 */

export type { SshOwnerAttachmentDescriptor } from "./sshOwnerProductionClient.attachment.ts";

export const SSH_OWNER_SYSTEM_SSH = "/usr/bin/ssh";
export const SSH_OWNER_SYSTEM_KEYSCAN = "/usr/bin/ssh-keyscan";

const OWNER_DIRECTORY = "ssh-owner";
const ATTACH_FILE = "attach.json";
const LOCK_FILE = "owner.lock";
const SOCKET_FILE = "owner.sock";

/** One target a production owner may serve, named per request. */
export type SshOwnerTargetDescriptor = ProofTargetDescriptorInput;

export interface SshOwnerProductionProfile {
  /** Private state directory whose `ssh-owner/` child holds the profile's owner facts. */
  readonly stateDirectory: string;
  /**
   * Optional primary target used for hydration/attach verification. The owner
   * itself starts without a target and resolves every request's descriptor.
   */
  readonly target?: SshOwnerTargetDescriptor;
  readonly workspaceRoot?: string;
  /** Exact initiating profile kind; omitted in fixtures, defaults to `desktop-dev`. */
  readonly kind?: SshOwnerProfile;
  /** Owner-selected installed agent for production per-target proxies. */
  readonly agentService?: {
    readonly binaryPath: string;
    readonly sha256: string;
    readonly stateDir: string;
  };
  /**
   * Owner-selected OpenCode v2 executable. The owner selects the argv, remote
   * port, listener, forward and per-lease credential; this is only the trusted
   * remote program path from the resolved artifact/config.
   */
  readonly opencodeV2Service?: OpencodeV2ServiceBinding;
  /** Typed settings refusal when the configured v2 binding is unusable. */
  readonly opencodeV2Refusal?: DevOpencodeV2ServiceRefusal;
  /** The user's `~/.ssh/config`, so alias targets resolve in the owner. */
  readonly aliasConfig?: string;
  /** The system SSH config read beside it; only with `aliasConfig`. */
  readonly systemConfig?: string;
}

export interface SshOwnerLaunchFacts {
  readonly profileBinding: Buffer;
  readonly profileBindingText: string;
  readonly stateDirectory: string;
  readonly directory: string;
  readonly lockFile: string;
  readonly socketPath: string;
  readonly attachFile: string;
  readonly workspaceRoot?: string;
  readonly target?: SshOwnerTargetDescriptor;
  readonly agentService?: {
    readonly binaryPath: string;
    readonly sha256: string;
    readonly stateDir: string;
  };
  readonly opencodeV2Service?: OpencodeV2ServiceBinding;
  readonly opencodeV2Refusal?: DevOpencodeV2ServiceRefusal;
  readonly aliasConfig?: string;
  readonly systemConfig?: string;
}

const invalid = (message: string, cause?: unknown) =>
  new SshOwnerClientError("invalid-profile", message, cause);

/** Validates the profile before a single child process or file is created. */
export function resolveSshOwnerLaunchFacts(
  profile: SshOwnerProductionProfile,
  binding?: SshOwnerProfileBinding,
): SshOwnerLaunchFacts {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new SshOwnerClientError(
      "unsupported-platform",
      "The native SSH owner has no production client on this platform yet.",
    );
  }
  if (
    !absolutePath(profile.stateDirectory) ||
    (profile.workspaceRoot !== undefined && !absolutePath(profile.workspaceRoot)) ||
    (profile.aliasConfig !== undefined && !absolutePath(profile.aliasConfig)) ||
    (profile.systemConfig !== undefined &&
      (profile.aliasConfig === undefined || !absolutePath(profile.systemConfig)))
  ) {
    throw invalid("The SSH owner production profile is not a valid launch binding.");
  }
  // A production owner serves many targets, so the v2 lane takes each
  // request's own absolute remote cwd; only the executable is bound here.
  if (
    profile.opencodeV2Service?.binaryPath !== undefined &&
    !isTrustedRemoteExecutablePath(profile.opencodeV2Service.binaryPath)
  ) {
    throw invalid("The OpenCode v2 service binding requires an absolute executable.");
  }
  if (profile.target !== undefined) {
    try {
      validateTargetDescriptor(profile.target);
    } catch (cause) {
      throw invalid("The SSH owner target descriptor is not valid.", cause);
    }
  }
  const identity =
    binding ??
    deriveSshOwnerProfileBinding({
      kind: profile.kind ?? "desktop-dev",
      stateDirectory: profile.stateDirectory,
    });
  if (identity.stateDirectory !== profile.stateDirectory) {
    throw invalid("The SSH owner profile binding names a different state directory.");
  }
  const directory = join(identity.stateDirectory, OWNER_DIRECTORY);
  const socketPath = join(directory, SOCKET_FILE);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_BYTES) {
    throw invalid("The SSH owner attachment socket path exceeds the platform limit.");
  }
  return {
    profileBinding: identity.digest,
    profileBindingText: identity.text,
    stateDirectory: identity.stateDirectory,
    directory,
    lockFile: join(directory, LOCK_FILE),
    socketPath,
    attachFile: join(directory, ATTACH_FILE),
    ...(profile.workspaceRoot === undefined ? {} : { workspaceRoot: profile.workspaceRoot }),
    ...(profile.target === undefined ? {} : { target: profile.target }),
    ...(profile.agentService === undefined ? {} : { agentService: profile.agentService }),
    ...(profile.opencodeV2Service === undefined
      ? {}
      : { opencodeV2Service: profile.opencodeV2Service }),
    ...(profile.opencodeV2Refusal === undefined
      ? {}
      : { opencodeV2Refusal: profile.opencodeV2Refusal }),
    ...(profile.aliasConfig === undefined ? {} : { aliasConfig: profile.aliasConfig }),
    ...(profile.systemConfig === undefined ? {} : { systemConfig: profile.systemConfig }),
  };
}

export interface SshOwnerLaunchInput extends Omit<PickerProofSessionOptions, "major"> {
  readonly artifact: SshOwnerArtifact;
  readonly facts: SshOwnerLaunchFacts;
  readonly capability: Buffer;
  readonly deadlineMs?: number;
}

const productionLaunchOptions = (input: SshOwnerLaunchInput) => ({
  productionLaunch: {
    startupDeadlineMs: input.deadlineMs ?? SSH_OWNER_WIRE_LIMITS.startupDeadlineMs,
    profileBindingText: input.facts.profileBindingText,
    stateDirectory: input.facts.stateDirectory,
    ...(input.facts.aliasConfig === undefined ? {} : { aliasConfig: input.facts.aliasConfig }),
    ...(input.facts.systemConfig === undefined ? {} : { systemConfig: input.facts.systemConfig }),
  },
});

/** Spawns the resolved artifact with private inherited handles and no shell. */
export async function spawnSshOwnerProduction(
  input: SshOwnerLaunchInput,
): Promise<LaunchedPickerProofOwner> {
  const { facts } = input;
  await ensurePrivateSshOwnerDirectory(facts.directory);
  return startPickerProofOwner({
    binary: input.artifact.path,
    profileBinding: input.profileBinding,
    sql: input.sql,
    lockFile: facts.lockFile,
    sshBinary: SSH_OWNER_SYSTEM_SSH,
    keyscanBinary: SSH_OWNER_SYSTEM_KEYSCAN,
    profileScope: facts.stateDirectory,
    ...(facts.target === undefined ? {} : { targetId: facts.target.targetId }),
    ...(facts.workspaceRoot === undefined ? {} : { workspaceRoot: facts.workspaceRoot }),
    attachment: { socketPath: facts.socketPath, capability: input.capability },
    ...(facts.agentService === undefined ? {} : { agentService: facts.agentService }),
    ...(facts.opencodeV2Service === undefined
      ? {}
      : { opencodeV2Service: facts.opencodeV2Service }),
    ...productionLaunchOptions(input),
  });
}

/** Attaches to the live owner named by the profile descriptor; never spawns. */
export async function attachSshOwnerProduction(
  input: Omit<PickerProofSessionOptions, "major"> & {
    readonly descriptor: SshOwnerAttachmentDescriptor;
  },
): Promise<PickerProofOwner> {
  return attachPickerProofOwner({
    profileBinding: input.profileBinding,
    ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    sql: input.sql,
    ...(input.profileScope === undefined ? {} : { profileScope: input.profileScope }),
    socketPath: input.descriptor.socketPath,
    capability: input.descriptor.capability,
  });
}

/** Maps a shared proof-client startup failure into a typed production failure. */
export function classifyStartupError(error: unknown): SshOwnerClientError {
  if (error instanceof SshOwnerClientError) return error;
  if (error instanceof PickerProofStartupTimeoutError) {
    return new SshOwnerClientError("startup-timeout", error.message, error);
  }
  if (
    error instanceof PickerProofStartupConfigError ||
    error instanceof PickerProofStartupRetirementError
  ) {
    return new SshOwnerClientError("owner-start-failed", error.message, error);
  }
  if (error instanceof PickerProofOwnerError) {
    if (error.code === "versionIncompatible") {
      return new SshOwnerClientError("version-incompatible", error.message, error);
    }
    if (error.code === "profileMismatch") {
      return new SshOwnerClientError(
        "profile-mismatch",
        "The SSH owner reported a different profile binding; refusing the session.",
        error,
      );
    }
    if (error.code === "protocolError") {
      return new SshOwnerClientError("wire-protocol-invalid", error.message, error);
    }
    if (error.code === "invalidOperands") {
      return new SshOwnerClientError("invalid-profile", error.message, error);
    }
    if (error.code === "ownerRetirementUnverified") {
      return new SshOwnerClientError("retirement-unverifiable", error.message, error);
    }
    if (error.code === "paneUnrecoverable") {
      return new SshOwnerClientError("pane-unrecoverable", error.message, error);
    }
    return new SshOwnerClientError("owner-start-failed", error.message, error);
  }
  return new SshOwnerClientError(
    "owner-start-failed",
    error instanceof Error ? error.message : "The SSH owner could not start.",
    error,
  );
}

/**
 * The user's SSH config paths for alias targets, when they exist. The owner
 * parses them itself (bounded, no spawn) and refuses an unsupported alias per
 * target, so a config the owner cannot admit never blocks owner startup.
 */
export async function resolveProductionSshConfigPaths(
  home: string,
  exists: (path: string) => Promise<boolean>,
): Promise<{ readonly aliasConfig?: string; readonly systemConfig?: string }> {
  const aliasConfig = join(home, ".ssh", "config");
  if (!(await exists(aliasConfig))) return {};
  const systemConfig = "/etc/ssh/ssh_config";
  return (await exists(systemConfig)) ? { aliasConfig, systemConfig } : { aliasConfig };
}
