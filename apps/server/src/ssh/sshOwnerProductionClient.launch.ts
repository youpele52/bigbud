import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  attachPickerProofOwner,
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
  type PickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import type { PickerProofSessionOptions } from "./sshOwnerPickerProof.client.session.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";
import {
  PickerProofStartupTimeoutError,
  PickerProofStartupConfigError,
  PickerProofStartupRetirementError,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";
import type { SshOwnerArtifact } from "./sshOwnerProductionArtifact.ts";
import {
  absolutePath,
  ensurePrivateSshOwnerDirectory,
  MAX_SOCKET_BYTES,
  type SshOwnerAttachmentDescriptor,
} from "./sshOwnerProductionClient.attachment.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";
import { SSH_OWNER_WIRE_LIMITS } from "./sshOwnerProductionClient.negotiate.ts";

/**
 * Fixed production launch facts for one initiating profile.
 *
 * The caller supplies the verified artifact facts and this profile binding; it
 * never supplies the owner executable, its argv or its environment. The
 * OpenSSH images are the owner's own allowlisted system paths.
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
const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface SshOwnerProductionProfile {
  /** Private state directory whose `ssh-owner/` child holds the profile's owner facts. */
  readonly stateDirectory: string;
  readonly targetId: string;
  /** The current disposable/production owner image is loopback-bound. */
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly workspaceRoot?: string;
}

export interface SshOwnerLaunchFacts {
  readonly profileBinding: Buffer;
  readonly targetId: string;
  readonly directory: string;
  readonly lockFile: string;
  readonly socketPath: string;
  readonly attachFile: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly workspaceRoot?: string;
}

const invalid = (message: string, cause?: unknown) =>
  new SshOwnerClientError("invalid-profile", message, cause);

/** Validates the profile before a single child process or file is created. */
export function resolveSshOwnerLaunchFacts(
  profile: SshOwnerProductionProfile,
): SshOwnerLaunchFacts {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new SshOwnerClientError(
      "unsupported-platform",
      "The native SSH owner has no production client on this platform yet.",
    );
  }
  if (
    !absolutePath(profile.stateDirectory) ||
    !profile.targetId ||
    Buffer.byteLength(profile.targetId) > 1_024 ||
    (profile.host !== "127.0.0.1" && profile.host !== "::1") ||
    !Number.isInteger(profile.port) ||
    profile.port < 1 ||
    profile.port > 65_535 ||
    !USER_PATTERN.test(profile.user) ||
    !absolutePath(profile.identityFile) ||
    !absolutePath(profile.knownHostsFile) ||
    (profile.workspaceRoot !== undefined && !absolutePath(profile.workspaceRoot))
  ) {
    throw invalid("The SSH owner production profile is not a valid loopback launch binding.");
  }
  const directory = join(profile.stateDirectory, OWNER_DIRECTORY);
  const socketPath = join(directory, SOCKET_FILE);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_BYTES) {
    throw invalid("The SSH owner attachment socket path exceeds the platform limit.");
  }
  const profileBinding = createHash("sha256")
    .update(
      JSON.stringify([
        "bigbud.ssh-owner.production-launch.v1",
        profile.stateDirectory,
        profile.targetId,
        profile.host,
        profile.port,
        profile.user,
        profile.identityFile,
        profile.knownHostsFile,
      ]),
    )
    .digest();
  return {
    profileBinding,
    targetId: profile.targetId,
    directory,
    lockFile: join(directory, LOCK_FILE),
    socketPath,
    attachFile: join(directory, ATTACH_FILE),
    host: profile.host,
    port: profile.port,
    user: profile.user,
    identityFile: profile.identityFile,
    knownHostsFile: profile.knownHostsFile,
    ...(profile.workspaceRoot === undefined ? {} : { workspaceRoot: profile.workspaceRoot }),
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
    targetId: input.targetId,
    sql: input.sql,
    lockFile: facts.lockFile,
    sshBinary: SSH_OWNER_SYSTEM_SSH,
    keyscanBinary: SSH_OWNER_SYSTEM_KEYSCAN,
    host: facts.host,
    port: facts.port,
    user: facts.user,
    identityFile: facts.identityFile,
    knownHostsFile: facts.knownHostsFile,
    ...(facts.workspaceRoot === undefined ? {} : { workspaceRoot: facts.workspaceRoot }),
    attachment: { socketPath: facts.socketPath, capability: input.capability },
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
    targetId: input.targetId,
    sql: input.sql,
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
    if (error.code === "protocolError") {
      return new SshOwnerClientError("wire-protocol-invalid", error.message, error);
    }
    if (error.code === "invalidOperands") {
      return new SshOwnerClientError("invalid-profile", error.message, error);
    }
    return new SshOwnerClientError("owner-start-failed", error.message, error);
  }
  return new SshOwnerClientError(
    "owner-start-failed",
    error instanceof Error ? error.message : "The SSH owner could not start.",
    error,
  );
}
