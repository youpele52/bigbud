import { createHash } from "node:crypto";

import type { ProviderKind } from "@bigbud/contracts";

import type { EffortCacheIdentity } from "./effortCache.types.ts";

export function fingerprintEffortScope(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function makeEffortCacheIdentity(input: {
  readonly provider: ProviderKind;
  readonly executionIdentity: string;
  readonly configFingerprint: string;
  readonly workspaceFingerprint: string;
  readonly subProviderID?: string | null | undefined;
  readonly modelID: string;
}): EffortCacheIdentity {
  return {
    provider: input.provider,
    executionIdentity: fingerprintEffortScope(input.executionIdentity),
    configFingerprint: fingerprintEffortScope(input.configFingerprint),
    workspaceFingerprint: fingerprintEffortScope(input.workspaceFingerprint),
    subProviderID: input.subProviderID?.trim() ?? "",
    modelID: input.modelID,
  };
}
