import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";

import {
  findWorkspaceAgentTarget,
  type WorkspaceAgentTarget,
} from "../../../../scripts/lib/workspace-agent-target.ts";
import type { ServerConfigShape } from "../startup/config.ts";

import {
  SshOwnerUnavailableError,
  type SshOwnerUnavailableReason,
} from "./sshOwnerStartupRefusal.ts";
import {
  findStandaloneSshOwnerTarget,
  StandaloneSshOwnerExecutableError,
  verifyStandaloneSshOwnerExecutable,
  type TrustedStandaloneSshOwnerManifestEntry,
} from "./sshOwnerExecutable.ts";
import { matchesSshOwnerExecutableTarget } from "./sshOwnerExecutable.header.ts";

/**
 * Production owner-artifact discovery for the four supported initiating
 * profiles. This is the production sibling of the dev-only selection in
 * `server.sshOwnerDev.ts`; it never reads `BIGBUD_SSH_OWNER`, never requires a
 * dev profile and never requires a loopback host.
 *
 * @module sshOwnerProductionArtifact
 */

export type SshOwnerProfile = "desktop-packaged" | "desktop-dev" | "standalone" | "remote-backend";

export interface SshOwnerArtifact {
  readonly profile: SshOwnerProfile;
  readonly path: string;
  readonly target: WorkspaceAgentTarget;
  /** How integrity was established; release builds provide a digest, D/V a native header. */
  readonly evidence: "digest" | "header";
}

export interface SshOwnerArtifactInput {
  readonly config: Pick<ServerConfigShape, "mode" | "devUrl">;
  readonly entryUrl: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Trusted digest from a release manifest, when the profile has one. */
  readonly trustedManifestEntry?: TrustedStandaloneSshOwnerManifestEntry;
}

export type SshOwnerArtifactResolution =
  | { readonly kind: "resolved"; readonly artifact: SshOwnerArtifact }
  | { readonly kind: "unavailable"; readonly error: SshOwnerUnavailableError };

export function resolveSshOwnerProfile(
  config: Pick<ServerConfigShape, "mode" | "devUrl">,
  environment: NodeJS.ProcessEnv = process.env,
): SshOwnerProfile {
  if (config.mode === "remote") return "remote-backend";
  if (config.mode === "desktop") {
    return environment.BIGBUD_DESKTOP_PACKAGED === "1" ? "desktop-packaged" : "desktop-dev";
  }
  // The Bun dev entry and the Electron dev backend both carry a Vite dev URL.
  return config.devUrl !== undefined ? "desktop-dev" : "standalone";
}

const unavailable = (reason: SshOwnerUnavailableReason, message: string) =>
  ({
    kind: "unavailable",
    error: new SshOwnerUnavailableError({ code: "sshOwnerUnavailable", reason, message }),
  }) as const;

const binaryName = (platform: WorkspaceAgentTarget["platform"]) =>
  platform === "win32" ? "bigbud-ssh-owner.exe" : "bigbud-ssh-owner";

/**
 * D (packaged), N and R all ship the U4 owner cells: macOS arm64/x64, Linux x64/arm64 and
 * Windows x64. Windows arm64 has no owner in v1. The list lives in `scripts/lib/packaged-ssh-owner.ts`
 * (via `findStandaloneSshOwnerTarget`) so packaging and discovery cannot drift.
 */
function resolveTarget(
  platform: NodeJS.Platform,
  arch: string,
  profile: SshOwnerProfile,
): WorkspaceAgentTarget | undefined {
  return profile === "desktop-dev"
    ? findWorkspaceAgentTarget(platform, arch)
    : findStandaloneSshOwnerTarget(platform, arch);
}

function resolvePackagedPath(entryUrl: string, target: WorkspaceAgentTarget): string {
  const serverRoot = dirname(dirname(fileURLToPath(entryUrl)));
  return join(serverRoot, "ssh-owner", "bin", binaryName(target.platform));
}

function resolveEnvBinary(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.BIGBUD_SSH_OWNER_BIN;
  return value !== undefined && isAbsolute(value) && normalize(value) === value ? value : undefined;
}

/** Read-only native header and permission check on the exact descriptor. */
async function verifyLocalBinary(
  path: string,
  target: WorkspaceAgentTarget,
): Promise<SshOwnerArtifactResolution> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) return unavailable("owner-unverified", path);
  if (target.platform !== "win32" && (stat.mode & 0o111n) === 0n) {
    return unavailable("owner-unverified", path);
  }
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const size = Number(stat.size);
    if (!(await matchesSshOwnerExecutableTarget(file, target, size))) {
      return unavailable("owner-incompatible", path);
    }
  } finally {
    await file.close();
  }
  return {
    kind: "resolved",
    artifact: { profile: "desktop-dev", path, target, evidence: "header" },
  };
}

const resolveLocal = (
  profile: "desktop-packaged" | "desktop-dev",
  path: string,
  target: WorkspaceAgentTarget,
): Effect.Effect<SshOwnerArtifactResolution> =>
  Effect.tryPromise({
    try: () => verifyLocalBinary(path, target),
    catch: (cause) =>
      cause instanceof SshOwnerUnavailableError
        ? cause
        : new SshOwnerUnavailableError({
            code: "sshOwnerUnavailable",
            reason:
              (cause as NodeJS.ErrnoException).code === "ENOENT"
                ? "owner-missing"
                : "owner-unverified",
            message: `The verified SSH owner artifact is not usable at ${path}.`,
          }),
  }).pipe(
    Effect.map(
      (resolution): SshOwnerArtifactResolution =>
        resolution.kind === "resolved"
          ? { ...resolution, artifact: { ...resolution.artifact, profile } }
          : resolution,
    ),
    Effect.catch(
      (error): Effect.Effect<SshOwnerArtifactResolution> =>
        Effect.succeed({ kind: "unavailable", error }),
    ),
  );

const resolveStandalone = (
  profile: "standalone" | "remote-backend",
  distDirectory: string,
  manifest: TrustedStandaloneSshOwnerManifestEntry | undefined,
  platform: NodeJS.Platform,
  arch: string,
): Effect.Effect<SshOwnerArtifactResolution> => {
  if (manifest === undefined)
    return Effect.succeed(
      unavailable(
        "owner-unverified",
        "The standalone SSH owner requires a digest from the authenticated release manifest.",
      ),
    );
  return Effect.tryPromise({
    try: () =>
      verifyStandaloneSshOwnerExecutable({
        distDirectory,
        trustedManifestEntry: manifest,
        platform,
        arch,
      }),
    catch: (cause) => {
      const detail = cause instanceof StandaloneSshOwnerExecutableError ? cause.reason : undefined;
      return new SshOwnerUnavailableError({
        code: "sshOwnerUnavailable",
        reason:
          detail === "unsupportedTarget"
            ? "owner-incompatible"
            : detail === "missingAsset" || (cause as NodeJS.ErrnoException).code === "ENOENT"
              ? "owner-missing"
              : "owner-unverified",
        message: "The standalone SSH owner artifact does not match its trusted manifest entry.",
      });
    },
  }).pipe(
    Effect.map(
      (path): SshOwnerArtifactResolution => ({
        kind: "resolved",
        artifact: {
          profile,
          path,
          target: findWorkspaceAgentTarget(platform, arch)!,
          evidence: "digest",
        },
      }),
    ),
    Effect.catch(
      (error): Effect.Effect<SshOwnerArtifactResolution> =>
        Effect.succeed({ kind: "unavailable", error }),
    ),
  );
};

/**
 * Resolve and verify the owner artifact for D/V/N/R. A missing, unsafe,
 * wrong-target or digest-mismatched artifact is a typed `sshOwnerUnavailable`;
 * it never falls back to a legacy launcher or to PATH.
 */
export const resolveSshOwnerArtifact = Effect.fn("resolveSshOwnerArtifact")(function* (
  input: SshOwnerArtifactInput,
) {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const profile = resolveSshOwnerProfile(input.config, environment);
  const target = resolveTarget(platform, arch, profile);
  if (!target)
    return unavailable(
      "owner-incompatible",
      `No verified SSH owner target exists for ${profile} on ${platform}/${arch}.`,
    );

  if (profile === "standalone" || profile === "remote-backend") {
    return yield* resolveStandalone(
      profile,
      dirname(fileURLToPath(input.entryUrl)),
      input.trustedManifestEntry,
      platform,
      arch,
    );
  }

  const envBinary = resolveEnvBinary(environment);
  if (profile === "desktop-dev" && envBinary === undefined)
    return unavailable(
      "owner-missing",
      "The development backend needs a built SSH owner; no absolute owner path was provided.",
    );
  // A packaged release always resolves its own staged artifact. The desktop
  // locator may confirm that path, but the environment may not substitute or
  // disable it.
  const packagedPath = resolvePackagedPath(input.entryUrl, target);
  const path =
    profile === "desktop-packaged"
      ? envBinary !== undefined && normalize(envBinary) === normalize(packagedPath)
        ? envBinary
        : packagedPath
      : envBinary!;
  return yield* resolveLocal(profile, path, target);
});
