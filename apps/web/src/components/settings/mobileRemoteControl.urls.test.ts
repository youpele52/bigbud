import { describe, expect, it, vi } from "vitest";

import {
  normalizeBackendBaseUrl,
  resolveDefaultBackendBaseUrl,
  resolveDefaultMobileWebBaseUrl,
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
    expect(resolveDefaultMobileWebBaseUrl()).toBe("http://192.168.1.24:5740");
  });

  it("uses the tailnet origin for remote mobile pairing", () => {
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
    expect(resolveDefaultMobileWebBaseUrl()).toBe("https://bigbud-dev.tail123.ts.net");
  });
});
