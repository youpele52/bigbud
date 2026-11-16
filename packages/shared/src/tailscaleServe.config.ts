/** Read-only Tailscale Serve handler parsing shared by desktop and remote owners. */
const LOOPBACK_PROXY_TARGET_HOST = "127.0.0.1";

export interface ServeHandlerEntry {
  /** Web listener key, for example `host.tailnet.ts.net:443`. */
  readonly listener: string;
  readonly path: string;
  /** Proxy target, or null for file/text handlers. */
  readonly proxy: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectServeHandlers(serveConfig: unknown): ServeHandlerEntry[] {
  if (!isRecord(serveConfig) || !isRecord(serveConfig.Web)) {
    return [];
  }
  const entries: ServeHandlerEntry[] = [];
  for (const [listener, listenerConfig] of Object.entries(serveConfig.Web)) {
    if (!isRecord(listenerConfig) || !isRecord(listenerConfig.Handlers)) {
      continue;
    }
    for (const [path, handler] of Object.entries(listenerConfig.Handlers)) {
      const proxy =
        isRecord(handler) && typeof handler.Proxy === "string" && handler.Proxy.trim().length > 0
          ? handler.Proxy.trim()
          : null;
      entries.push({ listener, path, proxy });
    }
  }
  return entries;
}

/** Returns the port when `target` is a loopback HTTP(S) proxy to the URL root, else null. */
export function parseLoopbackRootProxyPort(target: string): number | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (
      parsed.hostname !== LOOPBACK_PROXY_TARGET_HOST ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      (parsed.pathname !== "/" && parsed.pathname.length > 0) ||
      parsed.port.length === 0
    ) {
      return null;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}
