import {
  DEFAULT_MODEL_BY_PROVIDER,
  PROVIDER_KINDS,
  type ModelSelection,
  type ModelCapabilities,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { normalizeModelSlug } from "@bigbud/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  return providers.find((candidate) => candidate.provider === provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.enabled ?? true;
}

export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
): ProviderKind {
  if (provider && isProviderEnabled(providers, provider)) {
    return provider;
  }
  // Fall back to the first enabled provider in snapshot order, then PROVIDER_KINDS order.
  const fromSnapshot = providers.find((candidate) => candidate.enabled)?.provider;
  if (fromSnapshot) return fromSnapshot;
  return provider ?? PROVIDER_KINDS[0];
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}

/**
 * Returns the first provider snapshot that is enabled and has status "ready",
 * or `undefined` if no provider has completed probing successfully yet.
 */
export function getFirstReadyProvider(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  return providers.find((p) => p.enabled && p.status === "ready");
}

/**
 * Returns a default `ModelSelection` based on the first ready provider.
 * If no provider is ready yet, falls back to the first enabled provider
 * in snapshot order, then to the first entry in PROVIDER_KINDS.
 *
 * This is used when creating new projects/threads before the user has
 * made an explicit model choice.
 */
export function getDefaultModelSelection(providers: ReadonlyArray<ServerProvider>): ModelSelection {
  const ready = getFirstReadyProvider(providers);
  if (ready) {
    const firstModel = ready.models[0];
    const model = firstModel?.slug ?? DEFAULT_MODEL_BY_PROVIDER[ready.provider];
    return buildModelSelection(ready.provider, model, firstModel?.subProviderID);
  }
  const firstEnabled = providers.find((p) => p.enabled);
  if (firstEnabled) {
    const firstModel = firstEnabled.models[0];
    const model = firstModel?.slug ?? DEFAULT_MODEL_BY_PROVIDER[firstEnabled.provider];
    return buildModelSelection(firstEnabled.provider, model, firstModel?.subProviderID);
  }
  // No providers in snapshot yet — use first PROVIDER_KIND as last resort.
  const fallbackProvider = PROVIDER_KINDS[0];
  return { provider: fallbackProvider, model: DEFAULT_MODEL_BY_PROVIDER[fallbackProvider] };
}

function buildModelSelection(
  provider: ProviderKind,
  model: string,
  subProviderID: string | undefined,
): ModelSelection {
  // Include subProviderID for providers that support it (pi, opencode)
  if ((provider === "pi" || provider === "opencode") && subProviderID) {
    return { provider, model, subProviderID } as ModelSelection;
  }
  return { provider, model };
}
