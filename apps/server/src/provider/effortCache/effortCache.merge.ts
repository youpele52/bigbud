import type { ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import { isAuthoritativeEffortMetadata, withEffortProvenance } from "@bigbud/shared/model";

import type { EffortCacheEntry, EffortCacheIdentity } from "./effortCache.types.ts";
import { effortCacheKey } from "./effortCache.types.ts";

function overlayCapabilities(
  capabilities: ModelCapabilities | null,
  entry: EffortCacheEntry | undefined,
): ModelCapabilities | null {
  if (!capabilities) return capabilities;
  if (isAuthoritativeEffortMetadata(capabilities)) return capabilities;
  if (!entry) return capabilities;
  return withEffortProvenance(
    {
      ...capabilities,
      reasoningEffortLevels: [...entry.levels],
    },
    entry.status,
    "cache",
  );
}

export function overlayVerifiedEffortCache(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly entries: Readonly<Record<string, EffortCacheEntry>>;
  readonly identityFor: (model: ServerProviderModel) => EffortCacheIdentity;
}): ReadonlyArray<ServerProviderModel> {
  return input.models.map((model) => {
    const entry = input.entries[effortCacheKey(input.identityFor(model))];
    const capabilities = overlayCapabilities(model.capabilities, entry);
    return capabilities === model.capabilities ? model : { ...model, capabilities };
  });
}

export function verifiedEffortEntriesFromModels(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly identityFor: (model: ServerProviderModel) => EffortCacheIdentity;
  readonly generation: number;
  readonly verifiedAt: string;
}): ReadonlyArray<readonly [string, EffortCacheEntry]> {
  const result: Array<readonly [string, EffortCacheEntry]> = [];
  for (const model of input.models) {
    const caps = model.capabilities;
    if (!caps || !isAuthoritativeEffortMetadata(caps)) continue;
    // Cached capabilities are a read-through overlay. Persist only a fresh
    // provider report so a stale cache can never refresh its own timestamp.
    if (caps.effortMetadataOrigin !== "live") continue;
    const status =
      caps.effortMetadataStatus === "verified-unsupported"
        ? "verified-unsupported"
        : "verified-supported";
    if (status === "verified-supported" && caps.reasoningEffortLevels.length === 0) continue;
    result.push([
      effortCacheKey(input.identityFor(model)),
      {
        status,
        levels: [...caps.reasoningEffortLevels],
        verifiedAt: input.verifiedAt,
        generation: input.generation,
      },
    ]);
  }
  return result;
}
