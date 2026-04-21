import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
} from "@bigbud/contracts";
import { normalizeModelSlug, resolveSelectableModel } from "@bigbud/shared/model";
import { getComposerProviderState } from "../../components/chat/provider/composerProviderRegistry";
import { UnifiedSettings } from "@bigbud/contracts/settings";
import { cloneModelSelection, createModelSelection } from "./selection-helpers.models";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./provider.models";

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
  /** Sub-provider group label for display grouping (e.g. "Anthropic", "OpenAI"). Passed through from the server snapshot. */
  group?: string | undefined;
  /** Sub-provider ID for routing (e.g. "openrouter", "google"). Passed through from the server snapshot. */
  subProviderID?: string | undefined;
}

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  codex: {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
  copilot: {
    provider: "copilot",
    title: "Copilot",
    description: "Save additional GitHub Copilot model slugs for the picker and `/model` command.",
    placeholder: "your-copilot-model-slug",
    example: "gpt-5",
  },
  opencode: {
    provider: "opencode",
    title: "OpenCode",
    description: "Save additional OpenCode model slugs for the picker and `/model` command.",
    placeholder: "your-opencode-model-slug",
    example: "claude-sonnet-4-6",
  },
  pi: {
    provider: "pi",
    title: "Pi",
    description: "Save additional Pi model slugs for the picker and `/model` command.",
    placeholder: "your-pi-model-slug",
    example: "anthropic/claude-sonnet-4-20250514",
  },
  cursor: {
    provider: "cursor",
    title: "Cursor",
    description: "Save additional Cursor model slugs for the picker and `/model` command.",
    placeholder: "your-cursor-model-slug",
    example: "claude-sonnet-4-5",
  },
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG);

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getProviderModels(providers, provider).map(
    ({ slug, name, isCustom, group, subProviderID }) => {
      const option: AppModelOption = { slug, name, isCustom };
      if (group !== undefined) option.group = group;
      if (subProviderID !== undefined) option.subProviderID = subProviderID;
      return option;
    },
  );
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();
  const builtInModelSlugs = new Set(
    getProviderModels(providers, provider)
      .filter((model) => !model.isCustom)
      .map((model) => model.slug),
  );

  const customModels = settings.providers[provider].customModels;
  for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  const selectedModelMatchesExistingName =
    typeof trimmedSelectedModel === "string" &&
    options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
  if (
    normalizedSelectedModel &&
    !seen.has(normalizedSelectedModel) &&
    !selectedModelMatchesExistingName
  ) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
): Record<
  ProviderKind,
  ReadonlyArray<{
    slug: string;
    name: string;
    group?: string | undefined;
    subProviderID?: string | undefined;
  }>
> {
  return {
    codex: getAppModelOptions(
      settings,
      providers,
      "codex",
      selectedProvider === "codex" ? selectedModel : undefined,
    ),
    claudeAgent: getAppModelOptions(
      settings,
      providers,
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedModel : undefined,
    ),
    copilot: getAppModelOptions(
      settings,
      providers,
      "copilot",
      selectedProvider === "copilot" ? selectedModel : undefined,
    ),
    opencode: getAppModelOptions(
      settings,
      providers,
      "opencode",
      selectedProvider === "opencode" ? selectedModel : undefined,
    ),
    pi: getAppModelOptions(
      settings,
      providers,
      "pi",
      selectedProvider === "pi" ? selectedModel : undefined,
    ),
    cursor: getAppModelOptions(
      settings,
      providers,
      "cursor",
      selectedProvider === "cursor" ? selectedModel : undefined,
    ),
  };
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.textGenerationModelSelection ?? {
    provider: "codex" as const,
    model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
  };
  const provider = resolveSelectableProvider(providers, selection.provider);

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = provider === selection.provider ? selection.model : null;
  const model = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    prompt: "",
    modelOptions: {
      [provider]: provider === selection.provider ? selection.options : undefined,
    },
  });

  if (provider === selection.provider) {
    const baseSelection = createModelSelection(provider, model, modelOptionsForDispatch);
    return (provider === "opencode" || provider === "pi") &&
      "subProviderID" in selection &&
      selection.subProviderID
      ? cloneModelSelection(baseSelection, {
          subProviderID: selection.subProviderID,
        } as Partial<ModelSelection>)
      : baseSelection;
  }

  return createModelSelection(provider, model, modelOptionsForDispatch);
}
