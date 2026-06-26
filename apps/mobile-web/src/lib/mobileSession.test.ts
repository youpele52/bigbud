import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMobileSession,
  isMobileSessionExpired,
  readMobileSession,
  resolveMobileWebsocketUrl,
  writeMobileSession,
  type StoredMobileSession,
} from "./mobileSession";

const baseSession: StoredMobileSession = {
  sessionId: "session-1",
  sessionToken: "token-1",
  websocketUrl: "ws://127.0.0.1:3774/mobile-ws?token=stale",
  backendBaseUrl: "http://127.0.0.1:3774",
  scope: "thread-control",
  expiresAt: "2026-07-01T12:00:00.000Z",
};

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("mobileSession", () => {
  beforeEach(() => {
    const localStorage = createLocalStorageMock();
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("window", { localStorage });
  });

  it("persists and clears the paired mobile session", () => {
    writeMobileSession(baseSession);
    expect(readMobileSession()).toEqual(baseSession);
    clearMobileSession();
    expect(readMobileSession()).toBeNull();
  });

  it("treats expired sessions as invalid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T00:00:00.000Z"));
    expect(isMobileSessionExpired(baseSession)).toBe(true);
    vi.useRealTimers();
  });

  it("builds the mobile websocket url from the backend origin and session token", () => {
    expect(resolveMobileWebsocketUrl(baseSession)).toBe(
      "ws://127.0.0.1:3774/mobile-ws?token=token-1",
    );
  });

  it("uses wss when the backend is served over https", () => {
    expect(
      resolveMobileWebsocketUrl({
        ...baseSession,
        backendBaseUrl: "https://bigbud.example",
      }),
    ).toBe("wss://bigbud.example/mobile-ws?token=token-1");
  });
});
