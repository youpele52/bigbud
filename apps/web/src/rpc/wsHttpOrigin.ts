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

export function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  return resolveWsHttpOriginFrom({
    bridgeWsUrl: window.desktopBridge?.getWsUrl?.(),
    envWsUrl: import.meta.env.VITE_WS_URL as string | undefined,
    fallbackOrigin: window.location.origin,
  });
}
