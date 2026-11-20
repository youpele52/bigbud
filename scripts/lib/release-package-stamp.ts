import type { ReleaseMetadata } from "./release-metadata.ts";

/** Package manifests the release stamp edits; release source checks read the same list. */
export const releasePackageFiles = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

interface MutablePackageJson {
  version?: string;
  [key: string]: unknown;
}

/**
 * The exact bytes the release stamp writes for one of `releasePackageFiles`, or `null` when the
 * file already carries the release identity and is left untouched.
 */
export function stampReleasePackageJson(
  relativePath: (typeof releasePackageFiles)[number],
  text: string,
  release: ReleaseMetadata,
): string | null {
  const packageJson = JSON.parse(text) as MutablePackageJson;
  const isServer = relativePath === "apps/server/package.json";
  if (
    packageJson.version === release.version &&
    (!isServer || packageJson.bigbudReleaseTag === release.tag)
  ) {
    return null;
  }

  packageJson.version = release.version;
  if (isServer) packageJson.bigbudReleaseTag = release.tag;
  return `${JSON.stringify(packageJson, null, 2)}\n`;
}
