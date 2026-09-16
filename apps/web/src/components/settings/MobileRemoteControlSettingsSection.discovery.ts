import { queryOptions } from "@tanstack/react-query";

export const MOBILE_DEV_DISCOVERY_QUERY_KEY = ["mobile-dev-discovery"] as const;

export async function discoverMobileDevUrl(signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch("/__bigbud/mobile-dev", {
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3_000)])
        : AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || !("url" in data)) return null;
    if (typeof data.url !== "string") return null;
    const url = new URL(data.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return data.url.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function mobileDevDiscoveryQueryOptions() {
  return queryOptions({
    queryKey: MOBILE_DEV_DISCOVERY_QUERY_KEY,
    queryFn: ({ signal }) => discoverMobileDevUrl(signal),
    enabled: import.meta.env.DEV,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 2_000,
    retry: false,
  });
}
