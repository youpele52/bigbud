import { type ProviderKind, type ServerProvider } from "@bigbud/contracts";

import { PROVIDER_DESCRIPTORS } from "../../components/chat/provider/providerDescriptors";

export function isComposerProviderVisible(
  provider: ProviderKind,
  hiddenProviders: ReadonlyArray<ProviderKind>,
): boolean {
  return !hiddenProviders.includes(provider);
}

export function getVisibleComposerProviders(
  hiddenProviders: ReadonlyArray<ProviderKind>,
): ReadonlyArray<ProviderKind> {
  return PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.provider).filter((provider) =>
    isComposerProviderVisible(provider, hiddenProviders),
  );
}

export function getComposerProviderFallback(
  providers: ReadonlyArray<ServerProvider>,
  hiddenProviders: ReadonlyArray<ProviderKind>,
): ProviderKind | null {
  const visibleProviders = getVisibleComposerProviders(hiddenProviders);
  if (visibleProviders.length === 0) return null;

  const providerByKind = new Map(providers.map((provider) => [provider.provider, provider]));
  return (
    visibleProviders.find((provider) => {
      const snapshot = providerByKind.get(provider);
      return snapshot?.enabled && snapshot.status === "ready";
    }) ??
    visibleProviders.find((provider) => providerByKind.get(provider)?.enabled) ??
    visibleProviders[0]!
  );
}
