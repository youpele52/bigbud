import {
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerUsageSummaryResult,
} from "@bigbud/contracts";
import { normalizeModelSlug } from "@bigbud/shared/model";

import { formatSlugAsDisplayName } from "../chat/provider/ProviderModelPicker.models";

export function applyUsageDisplayLabels(
  summary: ServerUsageSummaryResult,
  providers: ReadonlyArray<ServerProvider>,
): ServerUsageSummaryResult {
  return {
    ...summary,
    providers: summary.providers.map((entry) => ({
      ...entry,
      label: resolveUsageProviderLabel(entry.id),
    })),
    models: summary.models.map((entry) => ({
      ...entry,
      label: resolveUsageModelLabel(entry.id, providers),
    })),
    favoriteProvider: summary.favoriteProvider
      ? {
          ...summary.favoriteProvider,
          label: resolveUsageProviderLabel(summary.favoriteProvider.id),
        }
      : null,
    favoriteModel: summary.favoriteModel
      ? {
          ...summary.favoriteModel,
          label: resolveUsageModelLabel(summary.favoriteModel.id, providers),
        }
      : null,
  };
}

function resolveUsageProviderLabel(providerId: string): string {
  const displayName = PROVIDER_DISPLAY_NAMES[providerId as keyof typeof PROVIDER_DISPLAY_NAMES];
  return displayName ?? providerId;
}

function resolveUsageModelLabel(modelId: string, providers: ReadonlyArray<ServerProvider>): string {
  for (const provider of providers) {
    const directMatch = findUsageModelMatch(provider, modelId);
    if (directMatch) {
      return directMatch.name ?? directMatch.slug;
    }

    const normalizedModelId = normalizeUsageModelId(modelId, provider.provider);
    if (normalizedModelId && normalizedModelId !== modelId) {
      const normalizedMatch = findUsageModelMatch(provider, normalizedModelId);
      if (normalizedMatch) {
        return normalizedMatch.name ?? normalizedMatch.slug;
      }
    }
  }

  return formatSlugAsDisplayName(modelId);
}

function findUsageModelMatch(provider: ServerProvider, modelId: string) {
  const directMatch = provider.models.find((model) => model.slug === modelId);
  if (directMatch) {
    return directMatch;
  }

  if (!modelId.includes("::")) {
    return undefined;
  }

  return provider.models.find((model) => `${model.slug}::${model.subProviderID ?? ""}` === modelId);
}

function normalizeUsageModelId(
  modelId: string,
  provider: ServerProvider["provider"],
): string | null {
  if (!modelId.includes("::")) {
    return normalizeModelSlug(modelId, provider);
  }

  const [slug, subProviderID] = modelId.split("::");
  const normalizedSlug = normalizeModelSlug(slug, provider);
  if (!normalizedSlug || !subProviderID) {
    return normalizedSlug;
  }

  return `${normalizedSlug}::${subProviderID}`;
}
