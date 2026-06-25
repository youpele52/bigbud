import { DEFAULT_MOBILE_WEB_PORT } from "@bigbud/shared/DevPorts";

import { resolveWsHttpOrigin } from "../../rpc/wsHttpOrigin";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function resolveDesktopMobileBackendBaseUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const bridgeBaseUrl = window.desktopBridge?.getMobileBackendBaseUrl?.();
  return typeof bridgeBaseUrl === "string" && bridgeBaseUrl.length > 0
    ? normalizeBackendBaseUrl(bridgeBaseUrl)
    : null;
}

export function normalizeBackendBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return resolveWsHttpOrigin();
  }

  try {
    const parsed = new URL(trimmed);
    const protocol =
      parsed.protocol === "ws:" ? "http:" : parsed.protocol === "wss:" ? "https:" : parsed.protocol;
    return stripTrailingSlash(`${protocol}//${parsed.host}`);
  } catch {
    return stripTrailingSlash(trimmed);
  }
}

export function resolveDefaultMobileWebBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_MOBILE_WEB_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return stripTrailingSlash(fromEnv);
  }
  const desktopBackendBaseUrl = resolveDesktopMobileBackendBaseUrl();
  if (desktopBackendBaseUrl) {
    const url = new URL(desktopBackendBaseUrl);
    url.port = String(DEFAULT_MOBILE_WEB_PORT);
    url.pathname = "/";
    return stripTrailingSlash(url.toString());
  }
  return `http://localhost:${DEFAULT_MOBILE_WEB_PORT}`;
}

export function resolveDefaultBackendBaseUrl(): string {
  return resolveDesktopMobileBackendBaseUrl() ?? normalizeBackendBaseUrl(resolveWsHttpOrigin());
}
