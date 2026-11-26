/**
 * U4 native SSH owner cells: the single list shared by packaging (desktop D, standalone N, remote R)
 * and runtime discovery. Windows arm64 has no owner in v1. Pure data, no Node imports.
 */
export const SSH_OWNER_TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "win32", arch: "x64" },
] as const;

export type SshOwnerTarget = (typeof SSH_OWNER_TARGETS)[number];

interface PlatformArch {
  readonly platform: string;
  readonly arch: string;
}

/** Narrows any `{ platform, arch }` target to the U4 owner cells. */
export function isSshOwnerReleaseTarget<T extends PlatformArch>(
  target: T | undefined,
): target is Extract<T, SshOwnerTarget> {
  return (
    target !== undefined &&
    SSH_OWNER_TARGETS.some(
      (candidate) => candidate.platform === target.platform && candidate.arch === target.arch,
    )
  );
}
