import { DEFAULT_MOBILE_WEB_PORT } from "@bigbud/shared/DevPorts";

import { resolveWsHttpOrigin } from "../../rpc/wsHttpOrigin";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
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
  return `http://localhost:${DEFAULT_MOBILE_WEB_PORT}`;
}

export function resolveDefaultBackendBaseUrl(): string {
  return normalizeBackendBaseUrl(resolveWsHttpOrigin());
}
