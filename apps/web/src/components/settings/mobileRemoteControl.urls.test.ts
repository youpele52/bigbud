import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_MOBILE_WEB_BASE_URL,
  normalizeBackendBaseUrl,
  resolveDefaultBackendBaseUrl,
  resolveDefaultMobileWebBaseUrl,
  resolveHostedMobileWebBaseUrl,
  resolveLocalMobileWebBaseUrl,
  resolveStoredBackendBaseUrl,
  resolveStoredMobileWebBaseUrl,
  shouldPreferLiveBackendBaseUrl,
  shouldResetMobileAppUrlToHosted,
} from "./mobileRemoteControl.urls";

describe("mobileRemoteControl.urls", () => {
  it("strips websocket auth tokens from backend origins", () => {
    expect(normalizeBackendBaseUrl("http://127.0.0.1:3774/?token=abc123")).toBe(
      "http://127.0.0.1:3774",
    );
    expect(normalizeBackendBaseUrl("ws://127.0.0.1:3774/?token=abc123")).toBe(
      "http://127.0.0.1:3774",
    );
  });

  it("resolves the desktop websocket bridge to an http origin", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:3774/?token=abc123",
        getMobileBackendBaseUrl: () => "http://192.168.1.24:3774",
      },
      location: {
        origin: "http://127.0.0.1:5734",
      },
    });

    expect(resolveDefaultBackendBaseUrl()).toBe("http://192.168.1.24:3774");
    expect(resolveLocalMobileWebBaseUrl()).toBe("http://192.168.1.24:5740");
    expect(resolveDefaultMobileWebBaseUrl()).toBe("http://192.168.1.24:5740");
  });

  it("uses the hosted mobile app for remote tailnet backends", () => {
    vi.stubEnv("VITE_MOBILE_WEB_URL", "http://localhost:5740");
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:3774/?token=abc123",
        getMobileBackendBaseUrl: () => "https://bigbud-dev.tail123.ts.net",
      },
      location: {
        origin: "http://127.0.0.1:5734",
      },
    });

    expect(resolveDefaultBackendBaseUrl()).toBe("https://bigbud-dev.tail123.ts.net");
    expect(resolveLocalMobileWebBaseUrl()).toBe("http://localhost:5740");
    expect(resolveDefaultMobileWebBaseUrl()).toBe("http://localhost:5740");
    expect(resolveHostedMobileWebBaseUrl()).toBe(HOSTED_MOBILE_WEB_BASE_URL);
  });

  it("keeps the production companion separate from the dev mobile web override", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://127.0.0.1:3020",
      },
    });

    expect(resolveHostedMobileWebBaseUrl()).toBe(HOSTED_MOBILE_WEB_BASE_URL);
  });

  it("resets stale tailnet mobile URLs when Tailscale remote access is enabled", () => {
    expect(
      shouldResetMobileAppUrlToHosted(
        "https://bigbud-dev.tail123.ts.net",
        "https://bigbud-dev.tail123.ts.net",
      ),
    ).toBe(true);
    expect(
      shouldResetMobileAppUrlToHosted(
        HOSTED_MOBILE_WEB_BASE_URL,
        "https://bigbud-dev.tail123.ts.net",
      ),
    ).toBe(false);
  });

  it("resets local mobile URLs when backend is remote tailnet", () => {
    expect(
      shouldResetMobileAppUrlToHosted(
        "http://192.168.1.24:5740",
        "https://bigbud-dev.tail123.ts.net",
      ),
    ).toBe(true);
  });

  it("keeps local mobile URLs when backend is also local", () => {
    expect(
      shouldResetMobileAppUrlToHosted("http://192.168.1.24:5740", "http://192.168.1.24:3774"),
    ).toBe(false);
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
    expect(
      resolveStoredMobileWebBaseUrl(
        "http://192.168.1.24:5740",
        "https://bigbud-dev.tail123.ts.net",
      ),
    ).toBe(HOSTED_MOBILE_WEB_BASE_URL);
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
