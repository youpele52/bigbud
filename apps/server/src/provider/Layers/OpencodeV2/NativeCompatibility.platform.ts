import {
  V2NativeCompatibilityError,
  type V2NativePlatform,
  type V2NativeArch,
} from "./NativeCompatibility.types.ts";

/** Platform candidacy is not qualification: actual API, ownership and policy checks still run. */
export function v2NativeRuntimePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch))
    throw new V2NativeCompatibilityError(
      "native-version-unsupported",
      "native platform/architecture is unsupported.",
    );
  return {
    platform: platform as typeof V2NativePlatform.Type,
    arch: arch as typeof V2NativeArch.Type,
  };
}

/** Evidence belongs to one release and machine ABI, never every installation of that version. */
export const v2NativeEvidenceKey = (version: string, platform: string, arch: string) =>
  JSON.stringify([version, platform, arch]);
