import { createHash } from "node:crypto";
import { realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

import * as Data from "effect/Data";

import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";

/**
 * Trusted production profile binding (W3.7).
 *
 * The binding is derived from the canonical state directory plus the initiating
 * profile kind. It is not a credential and is not secret; it is the value the
 * owner must receive at startup and echo in its hello. A packaged or remote
 * build never accepts an environment override, and only the existing dev
 * fixture gate may substitute a fixture binding.
 *
 * `bbso1:<kind>:<sha256-hex>` is the startup argv form. The hello carries the
 * 32-byte digest, which is what the owner validates and echoes.
 *
 * @module sshOwnerProductionProfile
 */

export const SSH_OWNER_PROFILE_BINDING_SCHEMA = "bigbud.ssh-owner.production-profile.v1";
export const SSH_OWNER_PROFILE_BINDING_PREFIX = "bbso1";
export const SSH_OWNER_PROFILE_BINDING_ENV = "BIGBUD_SSH_OWNER_PROFILE_BINDING";

const PROFILE_KINDS: ReadonlyArray<SshOwnerProfile> = [
  "desktop-packaged",
  "desktop-dev",
  "standalone",
  "remote-backend",
];

export type SshOwnerProfileRefusal =
  | "owner-profile-missing"
  | "owner-profile-not-canonical"
  | "owner-profile-not-directory"
  | "owner-profile-unexpected-boundary"
  | "owner-profile-unsafe"
  | "owner-profile-unavailable"
  | "owner-profile-mismatch";

export class SshOwnerProfileError extends Data.TaggedError("SshOwnerProfileError")<{
  readonly code: "sshOwnerProfileError";
  readonly reason: SshOwnerProfileRefusal;
  readonly message: string;
  readonly cause?: unknown;
}> {
  constructor(reason: SshOwnerProfileRefusal, message: string, cause?: unknown) {
    super({ code: "sshOwnerProfileError", reason, message, ...(cause ? { cause } : {}) });
  }
}

export interface SshOwnerProfileBinding {
  readonly kind: SshOwnerProfile;
  /** Canonical, absolute state directory the binding names. */
  readonly stateDirectory: string;
  readonly device: string;
  readonly inode: string;
  readonly digest: Buffer;
  /** `bbso1:<kind>:<hex>`; the exact startup argv value. */
  readonly text: string;
}

export interface DeriveSshOwnerProfileBindingInput {
  readonly kind: SshOwnerProfile;
  readonly stateDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * The existing dev-fixture gate (`isSshOwnerDevFixtureSelected`). Production
   * callers pass its live answer; only a gated dev build may use the env value.
   */
  readonly devFixtureGate?: boolean;
}

const isKind = (value: string): value is SshOwnerProfile =>
  (PROFILE_KINDS as ReadonlyArray<string>).includes(value);

const hexDigest = (value: string) =>
  /^[0-9a-f]{64}$/.test(value) ? Buffer.from(value, "hex") : undefined;

export const encodeSshOwnerProfileBinding = (
  kind: SshOwnerProfile,
  stateDirectory: string,
  digest: Buffer,
): string => `${SSH_OWNER_PROFILE_BINDING_PREFIX}:${kind}:${digest.toString("hex")}`;

/** Parses the startup form. Used for fixture overrides and diagnostics. */
export function parseSshOwnerProfileBinding(
  text: string,
): { readonly kind: SshOwnerProfile; readonly digest: Buffer } | undefined {
  const [prefix, kind, hex, ...rest] = text.split(":");
  if (prefix !== SSH_OWNER_PROFILE_BINDING_PREFIX || rest.length !== 0 || !kind || !hex) {
    return undefined;
  }
  const digest = hexDigest(hex);
  return isKind(kind) && digest ? { kind, digest } : undefined;
}

const digestFor = (kind: SshOwnerProfile, stateDirectory: string, device: string, inode: string) =>
  createHash("sha256")
    .update(
      [SSH_OWNER_PROFILE_BINDING_SCHEMA, kind, stateDirectory, device, inode].join("\0"),
      "utf8",
    )
    .digest();

/** Pure preimage used by both tests and derivation; the native owner recomputes it. */
export const sshOwnerProfileDigest = digestFor;

/**
 * Canonical state-directory identity. The device/inode pair makes the binding
 * name one filesystem object, and the device comparison refuses a state
 * directory that crosses an unexpected mount boundary from its parent.
 */
function readStateIdentity(stateDirectory: string) {
  if (!isAbsolute(stateDirectory) || normalize(stateDirectory) !== stateDirectory) {
    throw new SshOwnerProfileError(
      "owner-profile-not-canonical",
      "The SSH owner state directory is not an absolute normalized path.",
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(stateDirectory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SshOwnerProfileError(
        "owner-profile-missing",
        "The SSH owner state directory is missing.",
        cause,
      );
    }
    throw new SshOwnerProfileError(
      "owner-profile-unavailable",
      "The SSH owner state directory cannot be read.",
      cause,
    );
  }
  if (canonical !== stateDirectory) {
    throw new SshOwnerProfileError(
      "owner-profile-not-canonical",
      "The SSH owner state directory is a symlink or non-canonical path.",
    );
  }
  let info: BigIntStats;
  try {
    info = statSync(stateDirectory, { bigint: true });
  } catch (cause) {
    throw new SshOwnerProfileError(
      "owner-profile-unavailable",
      "The SSH owner state directory cannot be inspected.",
      cause,
    );
  }
  if (!info.isDirectory()) {
    throw new SshOwnerProfileError(
      "owner-profile-not-directory",
      "The SSH owner state directory is not a directory.",
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && Number(info.uid) !== uid) {
    throw new SshOwnerProfileError(
      "owner-profile-unsafe",
      "The SSH owner state directory is not owned by this user.",
    );
  }
  if ((info.mode & 0o022n) !== 0n) {
    throw new SshOwnerProfileError(
      "owner-profile-unsafe",
      "The SSH owner state directory is writable by other users.",
    );
  }
  let parentDevice: bigint;
  try {
    parentDevice = statSync(dirname(stateDirectory), { bigint: true }).dev;
  } catch (cause) {
    throw new SshOwnerProfileError(
      "owner-profile-unavailable",
      "The SSH owner state directory parent cannot be inspected.",
      cause,
    );
  }
  if (parentDevice !== info.dev) {
    throw new SshOwnerProfileError(
      "owner-profile-unexpected-boundary",
      "The SSH owner state directory crosses an unexpected filesystem boundary.",
    );
  }
  return { canonical, device: info.dev.toString(), inode: info.ino.toString() };
}

/**
 * Derives the binding and refuses typed when the state directory is missing,
 * non-canonical, unsafe or on an unexpected filesystem boundary.
 */
export function deriveSshOwnerProfileBinding(
  input: DeriveSshOwnerProfileBindingInput,
): SshOwnerProfileBinding {
  const environment = input.environment ?? process.env;
  const identity = readStateIdentity(input.stateDirectory);
  const fixture = input.devFixtureGate === true && input.kind === "desktop-dev";
  if (fixture) {
    const override = environment[SSH_OWNER_PROFILE_BINDING_ENV];
    if (override !== undefined && override.length > 0) {
      const parsed = parseSshOwnerProfileBinding(override);
      if (!parsed || parsed.kind !== input.kind) {
        throw new SshOwnerProfileError(
          "owner-profile-unavailable",
          "The development SSH owner fixture profile binding is malformed.",
        );
      }
      return {
        kind: parsed.kind,
        stateDirectory: identity.canonical,
        device: identity.device,
        inode: identity.inode,
        digest: parsed.digest,
        text: encodeSshOwnerProfileBinding(parsed.kind, identity.canonical, parsed.digest),
      };
    }
  }
  const digest = digestFor(input.kind, identity.canonical, identity.device, identity.inode);
  return {
    kind: input.kind,
    stateDirectory: identity.canonical,
    device: identity.device,
    inode: identity.inode,
    digest,
    text: encodeSshOwnerProfileBinding(input.kind, identity.canonical, digest),
  };
}
