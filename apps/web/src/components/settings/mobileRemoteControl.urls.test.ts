import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_MOBILE_WEB_BASE_URL,
  normalizeBackendBaseUrl,
  resolveSelectedMobileWebUrl,
  resolveStoredMobileWebSelection,
  resolveStoredBackendBaseUrl,
  shouldPreferLiveBackendBaseUrl,
} from "./mobileRemoteControl.urls";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("mobileRemoteControl.urls", () => {
  it("strips websocket auth tokens from backend origins", () => {
    expect(normalizeBackendBaseUrl("http://127.0.0.1:3774/?token=abc123")).toBe(
      "http://127.0.0.1:3774",
    );
    expect(normalizeBackendBaseUrl("ws://127.0.0.1:3774/?token=abc123")).toBe(
      "http://127.0.0.1:3774",
    );
  });

  it.each([
    "http://localhost:5741",
    "http://127.0.0.1:5800/mobile-preview",
    "http://192.168.1.24:5800/companion/",
    "https://custom.tail123.ts.net/app",
  ])("preserves the legacy custom URL %s regardless of env overrides", (customUrl) => {
    vi.stubEnv("VITE_MOBILE_WEB_URL", "http://localhost:5740");
    const selection = resolveStoredMobileWebSelection(null, customUrl, true);
    expect(selection).toEqual({ mode: "custom", customUrl });
    expect(resolveSelectedMobileWebUrl(selection, "http://localhost:5742")).toBe(
      customUrl.replace(/\/$/, ""),
    );
  });

  it("keeps hosted selection unchanged by discovery", () => {
    const selection = resolveStoredMobileWebSelection(null, HOSTED_MOBILE_WEB_BASE_URL, true);
    expect(selection.mode).toBe("hosted");
    expect(resolveSelectedMobileWebUrl(selection, "http://localhost:5742")).toBe(
      HOSTED_MOBILE_WEB_BASE_URL,
    );
    expect(resolveSelectedMobileWebUrl(selection, null)).toBe(HOSTED_MOBILE_WEB_BASE_URL);
  });

  it("defaults to automatic discovery in dev without inventing a URL when env is absent", () => {
    vi.stubEnv("VITE_MOBILE_WEB_URL", undefined);
    const selection = resolveStoredMobileWebSelection(null, null, true);
    expect(selection.mode).toBe("local");
    expect(resolveSelectedMobileWebUrl(selection, null)).toBeNull();
    expect(resolveSelectedMobileWebUrl(selection, "http://localhost:5742")).toBe(
      "http://localhost:5742",
    );
  });

  it("defaults to hosted in production, without a predicted local listener", () => {
    const selection = resolveStoredMobileWebSelection(null, null, false);
    expect(resolveSelectedMobileWebUrl(selection, null)).toBe(HOSTED_MOBILE_WEB_BASE_URL);
  });

  it("restores explicit selection before considering legacy storage", () => {
    expect(
      resolveStoredMobileWebSelection(
        JSON.stringify({ mode: "local", customUrl: "http://localhost:5900/path" }),
        HOSTED_MOBILE_WEB_BASE_URL,
        true,
      ),
    ).toEqual({ mode: "local", customUrl: "http://localhost:5900/path" });
    expect(resolveStoredMobileWebSelection("broken", "http://localhost:5900/path", true)).toEqual({
      mode: "custom",
      customUrl: "http://localhost:5900/path",
    });
  });

  it("prefers live tailnet backend over stale local storage", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getMobileBackendBaseUrl: () => "https://bigbud-dev.tail123.ts.net",
      },
    });

    expect(
      shouldPreferLiveBackendBaseUrl(
        "http://192.168.1.24:3774",
        "https://bigbud-dev.tail123.ts.net",
      ),
    ).toBe(true);
    expect(resolveStoredBackendBaseUrl("http://192.168.1.24:3774")).toBe(
      "https://bigbud-dev.tail123.ts.net",
    );
  });

  it("prefers live local backend after Tailscale Serve is disabled", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getMobileBackendBaseUrl: () => "http://192.168.1.24:3774",
      },
    });

    expect(
      shouldPreferLiveBackendBaseUrl(
        "https://bigbud-dev.tail123.ts.net",
        "http://192.168.1.24:3774",
      ),
    ).toBe(true);
    expect(resolveStoredBackendBaseUrl("https://bigbud-dev.tail123.ts.net")).toBe(
      "http://192.168.1.24:3774",
    );
  });
});
