import type { ModelListOutput } from "@opencode/client";
import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";

/** Pure V2 catalog boundary: independent provider IDs/variants, no V1 cache assumptions. */
export function normalizeV2Catalog(
  catalog: ModelListOutput,
  location: string,
): ReadonlyArray<ServerProviderModel> {
  if (catalog.location.directory !== location || catalog.data.length > 10_000) {
    throw new Error("OpenCode v2 catalog ownership or size rejected.");
  }
  const seen = new Set<string>();
  return catalog.data
    .filter((model) => model.enabled && model.status !== "deprecated")
    .map((model) => {
      const key = JSON.stringify([model.providerID, model.id]);
      if (!model.providerID.trim() || !model.id.trim() || seen.has(key)) {
        throw new Error("OpenCode v2 catalog identity is ambiguous.");
      }
      seen.add(key);
      return {
        slug: model.id,
        subProviderID: model.providerID,
        name: model.name,
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: model.variants.map((variant) => ({
            value: variant.id,
            label: variant.id,
          })),
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          effortMetadataStatus: model.variants.length
            ? ("verified-supported" as const)
            : ("verified-unsupported" as const),
          effortMetadataOrigin: "live" as const,
        },
      };
    });
}
