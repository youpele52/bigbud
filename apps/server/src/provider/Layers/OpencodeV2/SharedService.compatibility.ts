import { V2SharedServiceError } from "./SharedService.errors.ts";

export const V2_RECOMMENDED_RUNTIME_VERSION = "2.0.26";

/** Native API/transport qualification only; full application/release gates are separate. */
export const V2_SHARED_RUNTIME_QUALIFICATIONS = {
  "2.0.24": { fixture: "SharedService.native.test.ts", scope: "native-api-transport" },
  "2.0.26": { fixture: "SharedService.native.test.ts", scope: "native-api-transport" },
} as const;

export const V2_MINIMUM_RUNTIME_VERSION = "2.0.24";

/** Release evidence is not an allowlist; every accepted service also passes protocol checks. */
export function assertV2SharedQualifiedVersion(version: string): void {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const numbers = parts?.slice(1).map(Number);
  if (
    !numbers ||
    numbers.some((part) => !Number.isSafeInteger(part)) ||
    numbers[0] !== 2 ||
    (numbers[1] === 0 && numbers[2]! < 24)
  )
    throw new V2SharedServiceError(
      "compatibility",
      `OpenCode ${/^\d+\.\d+\.\d+$/.test(version) ? version : "unknown version"} is unsupported. Shared mode requires stable V2 ${V2_MINIMUM_RUNTIME_VERSION} or newer with compatible APIs (not V3); bigbud never updates or replaces your service.`,
      /^2\.\d+\.\d+$/.test(version) ? version : undefined,
    );
}

export function isV2SharedUpdateRecommended(version: string): boolean {
  assertV2SharedQualifiedVersion(version);
  const [, minor, patch] = version.split(".").map(Number);
  return minor === 0 && patch! < 26;
}

/** App-session bounded notice deduplication; reconnect/catalog refresh never repeats it. */
export function makeV2SharedUpdateNotice() {
  let notified = false;
  return (
    version: string,
  ): { readonly severity: "warning"; readonly message: string } | undefined => {
    assertV2SharedQualifiedVersion(version);
    const older = isV2SharedUpdateRecommended(version);
    if (!older || notified) return;
    notified = true;
    return {
      severity: "warning",
      message: `OpenCode v2 ${version} is compatible. Update to ${V2_RECOMMENDED_RUNTIME_VERSION}+ when convenient; your current service remains usable.`,
    };
  };
}
