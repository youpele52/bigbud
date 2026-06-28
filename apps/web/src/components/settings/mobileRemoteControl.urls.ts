import { DEFAULT_MOBILE_WEB_PORT } from "@bigbud/shared/DevPorts";

import { resolveWsHttpOrigin } from "../../rpc/wsHttpOrigin";

export const HOSTED_MOBILE_WEB_BASE_URL = "https://mobile.bigbud.app";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isLocalDesktopBackendProtocol(protocol: string): boolean {
  return protocol === "http:";
}

function isTailnetHostname(hostname: string): boolean {
  return hostname.endsWith(".ts.net");
}

export function resolveHostedMobileWebBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_MOBILE_WEB_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return stripTrailingSlash(fromEnv);
  }
  return HOSTED_MOBILE_WEB_BASE_URL;
}

export function shouldResetMobileAppUrlToHosted(
  mobileBaseUrl: string,
  backendBaseUrl: string,
): boolean {
  const mobile = mobileBaseUrl.trim();
  if (mobile.length === 0) {
    return true;
  }

  try {
    const normalizedBackend = normalizeBackendBaseUrl(backendBaseUrl);
    const normalizedMobile = stripTrailingSlash(mobile);
    if (normalizedMobile === normalizedBackend) {
      return true;
    }
    const mobileUrl = new URL(normalizedMobile);
    if (isTailnetHostname(mobileUrl.hostname)) {
      return true;
    }
    const backendUrl = new URL(normalizedBackend);
    if (
      isTailnetHostname(backendUrl.hostname) &&
      isLocalDesktopBackendProtocol(mobileUrl.protocol)
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function shouldPreferLiveBackendBaseUrl(stored: string, live: string): boolean {
  try {
    const storedUrl = new URL(stored);
    const liveUrl = new URL(live);
    const storedLocal = isLocalDesktopBackendProtocol(storedUrl.protocol);
    const liveLocal = isLocalDesktopBackendProtocol(liveUrl.protocol);
    if (isTailnetHostname(liveUrl.hostname) && storedLocal) {
      return true;
    }
    if (isTailnetHostname(storedUrl.hostname) && liveLocal) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveStoredBackendBaseUrl(stored: string | null | undefined): string {
  const liveDefault = normalizeBackendBaseUrl(resolveDefaultBackendBaseUrl());
  const storedValue = stored?.trim();
  if (!storedValue) {
    return liveDefault;
  }
  const normalizedStored = normalizeBackendBaseUrl(storedValue);
  if (shouldPreferLiveBackendBaseUrl(normalizedStored, liveDefault)) {
    return liveDefault;
  }
  return normalizedStored;
}

export function resolveStoredMobileWebBaseUrl(
  stored: string | null | undefined,
  backendBaseUrl: string,
): string {
  const fallback = resolveDefaultMobileWebBaseUrl();
  const storedValue = stored?.trim();
  if (!storedValue) {
    return fallback;
  }
  if (shouldResetMobileAppUrlToHosted(storedValue, backendBaseUrl)) {
    return fallback;
  }
  return stripTrailingSlash(storedValue);
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
  const desktopBackendBaseUrl = resolveDesktopMobileBackendBaseUrl();
  if (desktopBackendBaseUrl) {
    const url = new URL(desktopBackendBaseUrl);
    if (!isLocalDesktopBackendProtocol(url.protocol)) {
      return resolveHostedMobileWebBaseUrl();
    }
    url.port = String(DEFAULT_MOBILE_WEB_PORT);
    url.pathname = "/";
    return stripTrailingSlash(url.toString());
  }
  const fromEnv = import.meta.env.VITE_MOBILE_WEB_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return stripTrailingSlash(fromEnv);
  }
  return `http://localhost:${DEFAULT_MOBILE_WEB_PORT}`;
}

export function resolveDefaultBackendBaseUrl(): string {
  return resolveDesktopMobileBackendBaseUrl() ?? normalizeBackendBaseUrl(resolveWsHttpOrigin());
}
