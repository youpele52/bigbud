import type { EffortOption, ProviderKind } from "@bigbud/contracts";

export const EFFORT_CAPABILITY_CACHE_VERSION = 1;
export const EFFORT_CAPABILITY_CACHE_MAX_ENTRIES = 2_000;
export const EFFORT_CAPABILITY_CACHE_MAX_BYTES = 1_000_000;

export interface EffortCacheIdentity {
  readonly provider: ProviderKind;
  readonly executionIdentity: string;
  readonly configFingerprint: string;
  readonly workspaceFingerprint: string;
  readonly subProviderID: string;
  readonly modelID: string;
}

export interface EffortCacheEntry {
  readonly status: "verified-supported" | "verified-unsupported";
  readonly levels: ReadonlyArray<EffortOption>;
  readonly verifiedAt: string;
  readonly generation: number;
}

export interface EffortCacheFile {
  readonly version: number;
  readonly entries: Record<string, EffortCacheEntry>;
}

export function effortCacheKey(identity: EffortCacheIdentity): string {
  return [
    identity.provider,
    identity.executionIdentity,
    identity.configFingerprint,
    identity.workspaceFingerprint,
    identity.subProviderID,
    identity.modelID,
    String(EFFORT_CAPABILITY_CACHE_VERSION),
  ].join("\u001f");
}
