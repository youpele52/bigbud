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

export function resolveDefaultBackendBaseUrl(): string {
  return resolveDesktopMobileBackendBaseUrl() ?? normalizeBackendBaseUrl(resolveWsHttpOrigin());
}

export type MobileWebUrlMode = "local" | "hosted" | "custom";

export interface MobileWebUrlSelection {
  readonly mode: MobileWebUrlMode;
  readonly customUrl: string;
}

export function resolveStoredMobileWebSelection(
  storedSelection: string | null,
  legacyUrl: string | null,
  isDev: boolean,
): MobileWebUrlSelection {
  if (storedSelection) {
    try {
      const parsed: unknown = JSON.parse(storedSelection);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "mode" in parsed &&
        "customUrl" in parsed &&
        typeof parsed.customUrl === "string" &&
        (parsed.mode === "local" || parsed.mode === "hosted" || parsed.mode === "custom")
      ) {
        return {
          mode: parsed.mode === "local" && !isDev ? "hosted" : parsed.mode,
          customUrl: parsed.customUrl,
        };
      }
    } catch {
      // Preserve the legacy URL if a newer preference cannot be read.
    }
  }
  const customUrl = legacyUrl?.trim() ?? "";
  if (customUrl) {
    return {
      mode: stripTrailingSlash(customUrl) === HOSTED_MOBILE_WEB_BASE_URL ? "hosted" : "custom",
      customUrl,
    };
  }
  return { mode: isDev ? "local" : "hosted", customUrl: "" };
}

export function resolveSelectedMobileWebUrl(
  selection: MobileWebUrlSelection,
  liveUrl: string | null,
): string | null {
  switch (selection.mode) {
    case "local":
      return liveUrl;
    case "hosted":
      return HOSTED_MOBILE_WEB_BASE_URL;
    case "custom":
      return stripTrailingSlash(selection.customUrl.trim()) || null;
  }
}
