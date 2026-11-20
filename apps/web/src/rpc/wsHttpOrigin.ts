import { isBoundBackendWindow, readBoundHttpEndpoint } from "./backendScope.state";

export function resolveWsHttpOriginFrom(input: {
  readonly bridgeWsUrl: string | null | undefined;
  readonly envWsUrl: string | undefined;
  readonly fallbackOrigin: string;
}): string {
  const { bridgeWsUrl, envWsUrl, fallbackOrigin } = input;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;

  if (!wsCandidate) return fallbackOrigin;

  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return fallbackOrigin;
  }
}

/** Asset and attachment origin. A bound window uses its relay lease origin, and never the local
 * backend; until the lease exists it returns "" so URLs stay relative to the renderer. */
export function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  if (isBoundBackendWindow()) return readBoundHttpEndpoint()?.origin ?? "";
  return resolveWsHttpOriginFrom({
    bridgeWsUrl: window.desktopBridge?.getWsUrl?.(),
    envWsUrl: import.meta.env.VITE_WS_URL as string | undefined,
    fallbackOrigin: window.location.origin,
  });
}

/** Headers a `fetch` to `resolveWsHttpOrigin()` must carry: the lease credential and client RPC
 * revision for a bound window, none for the local backend. Tag-loaded assets (img, iframe) get the
 * same headers from the desktop shell, which binds them to this window's lease origin only. */
export function resolveWsHttpRequestHeaders(): Readonly<Record<string, string>> {
  if (typeof window === "undefined" || !isBoundBackendWindow()) return {};
  return readBoundHttpEndpoint()?.headers ?? {};
}
