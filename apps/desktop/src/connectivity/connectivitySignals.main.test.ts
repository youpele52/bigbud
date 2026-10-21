import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isOnline: vi.fn(() => true),
  powerMonitor: null as EventEmitter | null,
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  mocks.powerMonitor = new Emitter();
  return {
    BrowserWindow: { getAllWindows: () => [] },
    net: { isOnline: mocks.isOnline },
    powerMonitor: mocks.powerMonitor,
  };
});
vi.mock("../backend/backendManager", () => ({
  backendWsUrl: "",
  restartUnresponsiveBackend: vi.fn(),
}));
vi.mock("../backend/backendResumeProbe", () => ({ probeBackendAfterResume: vi.fn() }));
vi.mock("../backend/backendStartupState", () => ({
  getBackendStartupState: vi.fn(),
  republishBackendStartupState: vi.fn(),
}));

import {
  startDesktopConnectivitySignals,
  stopDesktopConnectivitySignals,
} from "./connectivitySignals.main";

const options = { channel: "connectivity", getIsQuitting: () => false, logHeader: vi.fn() };

function powerListenerCount(): number {
  const monitor = mocks.powerMonitor!;
  return ["suspend", "resume", "lock-screen", "unlock-screen"].reduce(
    (total, event) => total + monitor.listenerCount(event),
    0,
  );
}

afterEach(() => {
  stopDesktopConnectivitySignals();
});

describe("desktop connectivity signals teardown", () => {
  it("removes power listeners and the online poll on quit", () => {
    vi.useFakeTimers();
    try {
      startDesktopConnectivitySignals(options);
      expect(powerListenerCount()).toBeGreaterThan(0);
      mocks.isOnline.mockClear();

      stopDesktopConnectivitySignals();
      expect(powerListenerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(mocks.isOnline).not.toHaveBeenCalled();
      // Idempotent: a second quit path calling teardown again is harmless.
      expect(() => stopDesktopConnectivitySignals()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never leaves two monitors attached when started twice", () => {
    startDesktopConnectivitySignals(options);
    const attached = powerListenerCount();
    startDesktopConnectivitySignals(options);
    expect(powerListenerCount()).toBe(attached);
  });
});
