import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { parseV2CanonicalCandidate } from "./NativeCompatibility.version.ts";

/** The supported client version; a service at or above it needs no update notice. */
export const V2_RECOMMENDED_RUNTIME_VERSION = OPENCODE_V2_CLIENT_VERSION;

/** Native API/transport qualification only; full application/release gates are separate. */
export const V2_SHARED_RUNTIME_QUALIFICATIONS = {
  "2.0.24": { fixture: "SharedService.native.test.ts", scope: "native-api-transport" },
  "2.0.26": { fixture: "SharedService.native.test.ts", scope: "native-api-transport" },
} as const;

/** Release evidence is not an allowlist; every accepted service also passes protocol checks. */
export function assertV2SharedQualifiedVersion(version: string): void {
  if (!parseV2CanonicalCandidate(version))
    throw new V2SharedServiceError(
      "compatibility",
      `OpenCode ${/^\d+\.\d+\.\d+$/.test(version) ? version : "unknown version"} is unsupported. Shared mode requires stable V2 with compatible APIs (not V1, V3 or prereleases); bigbud never updates or replaces your service.`,
      /^2\.\d+\.\d+$/.test(version) ? version : undefined,
    );
}

export function isV2SharedUpdateRecommended(version: string): boolean {
  assertV2SharedQualifiedVersion(version);
  const current = parseV2CanonicalCandidate(version)!;
  const supported = parseV2CanonicalCandidate(V2_RECOMMENDED_RUNTIME_VERSION)!;
  return (
    current.minor < supported.minor ||
    (current.minor === supported.minor && current.patch < supported.patch)
  );
}
