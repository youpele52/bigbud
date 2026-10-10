import { V2SharedServiceError } from "./SharedService.errors.ts";

export const V2_RECOMMENDED_RUNTIME_VERSION = "2.0.26";

/** Native API/transport qualification only; full application/release gates are separate. */
export const V2_SHARED_RUNTIME_QUALIFICATIONS = {
  "2.0.24": { fixture: "SharedService.native.test.ts", scope: "native-api-transport" },
  "2.0.26": { fixture: "SharedService.native.test.ts", scope: "native-api-transport" },
} as const;

/** Baseline is advisory, not a semver permission to trust unknown newer protocols. */
export function assertV2SharedQualifiedVersion(version: string): void {
  if (!Object.hasOwn(V2_SHARED_RUNTIME_QUALIFICATIONS, version))
    throw new V2SharedServiceError(
      "compatibility",
      `OpenCode v2 ${/^2\.\d+\.\d+$/.test(version) ? version : "unknown version"} is not qualified for bigbud's shared-service client. Use a qualified runtime (recommended ${V2_RECOMMENDED_RUNTIME_VERSION}+) or wait for compatibility qualification; bigbud never updates or replaces your service.`,
      /^2\.\d+\.\d+$/.test(version) ? version : undefined,
    );
}

/** App-session bounded notice deduplication; reconnect/catalog refresh never repeats it. */
export function makeV2SharedUpdateNotice() {
  let notified = false;
  return (
    version: string,
  ): { readonly severity: "warning"; readonly message: string } | undefined => {
    assertV2SharedQualifiedVersion(version);
    const [major, minor, patch] = version.split(".").map(Number);
    const older = major === 2 && minor === 0 && patch! < 26;
    if (!older || notified) return;
    notified = true;
    return {
      severity: "warning",
      message: `OpenCode v2 ${version} is compatible. Update to ${V2_RECOMMENDED_RUNTIME_VERSION}+ when convenient; your current service remains usable.`,
    };
  };
}
