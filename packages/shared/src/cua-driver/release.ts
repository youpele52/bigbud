import type {
  CuaDriverReleaseArtifact,
  CuaDriverReleaseTable,
  CuaDriverRuntimeArch,
  CuaDriverRuntimePlatform,
} from "./release.types.ts";
import { CUA_DRIVER_0_9_1_ARTIFACTS } from "./release.v0_9_1.ts";
import { CUA_DRIVER_0_38_0_ARTIFACTS } from "./release.v0_38_0.ts";

/**
 * The pin. Flipping it selects that release's table only: the public contract
 * profile stays `legacy` (`@bigbud/shared/computer-use/selection`) and the
 * supervised gate stays closed.
 */
export type CuaDriverKnownVersion = "0.9.1" | "0.38.0";
export const CUA_DRIVER_VERSION: CuaDriverKnownVersion = "0.38.0";
export const CUA_DRIVER_REPOSITORY = "trycua/cua";
export const CUA_DRIVER_RELEASE_TAG = `cua-driver-rs-v${CUA_DRIVER_VERSION}`;

export type {
  CuaDriverReleaseArtifact,
  CuaDriverRuntimeArch,
  CuaDriverRuntimePlatform,
} from "./release.types.ts";

const RELEASES: Readonly<Record<CuaDriverKnownVersion, CuaDriverReleaseTable>> = {
  "0.9.1": CUA_DRIVER_0_9_1_ARTIFACTS,
  "0.38.0": CUA_DRIVER_0_38_0_ARTIFACTS,
};

export class CuaDriverArtifactUnverifiedError extends Error {
  constructor(version: string, platform: string, arch: string) {
    super(`No verified Cua Driver ${version} artifact exists for ${platform}-${arch}.`);
  }
}

export function resolveCuaDriverReleaseArtifactFor(
  version: CuaDriverKnownVersion,
  platform: CuaDriverRuntimePlatform,
  arch: CuaDriverRuntimeArch,
): CuaDriverReleaseArtifact {
  const artifact = RELEASES[version][platform][arch];
  if (!artifact) throw new CuaDriverArtifactUnverifiedError(version, platform, arch);
  return artifact;
}

export function resolveCuaDriverReleaseArtifact(
  platform: CuaDriverRuntimePlatform,
  arch: CuaDriverRuntimeArch,
): CuaDriverReleaseArtifact {
  return resolveCuaDriverReleaseArtifactFor(CUA_DRIVER_VERSION, platform, arch);
}

/** `version` defaults to the pin; pass it when resolving another release's artifact. */
export function cuaDriverReleaseUrl(
  artifact: CuaDriverReleaseArtifact,
  version: CuaDriverKnownVersion = CUA_DRIVER_VERSION,
): string {
  const tag = version === CUA_DRIVER_VERSION ? CUA_DRIVER_RELEASE_TAG : `cua-driver-rs-v${version}`;
  return `https://github.com/${CUA_DRIVER_REPOSITORY}/releases/download/${tag}/${artifact.archiveName}`;
}
