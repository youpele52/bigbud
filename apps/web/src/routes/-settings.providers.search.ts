import { PROVIDER_KINDS, type ProviderKind } from "@bigbud/contracts";

export function parseExpandedProvidersSearch(search: unknown): ReadonlyArray<ProviderKind> {
  if (!search || typeof search !== "object") return [];
  const providers = (search as { readonly providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  return providers.filter(
    (provider): provider is ProviderKind =>
      typeof provider === "string" && PROVIDER_KINDS.includes(provider as ProviderKind),
  );
}
