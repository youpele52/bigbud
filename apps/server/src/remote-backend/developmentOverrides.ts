/**
 * Development graph overrides (a local graph directory, extra pinned keys, a local Rust install
 * source) are a development option. They are refused in release mode: a packaged desktop app
 * (`BIGBUD_DESKTOP_PACKAGED=1`) or any release build, whose server package the release workflows
 * stamp with `bigbudReleaseTag`. The laptop deployment and the backend's runtime updates share
 * this one rule.
 */
import serverPackageJson from "../../package.json" with { type: "json" };

export function developmentGraphOverridesAllowed(
  environment: NodeJS.ProcessEnv,
  packageMetadata: {
    readonly version: string;
    readonly bigbudReleaseTag?: unknown;
  } = serverPackageJson,
): boolean {
  return (
    environment.BIGBUD_DESKTOP_PACKAGED !== "1" && packageMetadata.bigbudReleaseTag === undefined
  );
}
