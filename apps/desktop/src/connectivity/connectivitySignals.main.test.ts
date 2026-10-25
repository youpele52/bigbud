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
vi.mock("../backend/backendResumeProbe", () => ({
  probeBackendAfterResume: vi.fn(async () => undefined),
}));
const writeHint = vi.hoisted(() =>
  vi.fn<(hint: { readonly kind: string; readonly online: boolean | null }) => boolean>(() => true),
);
vi.mock("../backend/backendLifecycleHintPipe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend/backendLifecycleHintPipe")>()),
  writeBackendLifecycleHint: writeHint,
}));
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

describe("desktop connectivity hints to the server", () => {
  it("forwards suspend, resume and network changes over the hint pipe, not lock events", () => {
    writeHint.mockClear();
    startDesktopConnectivitySignals(options);
    const monitor = mocks.powerMonitor!;

    monitor.emit("lock-screen");
    monitor.emit("suspend");
    expect(writeHint).toHaveBeenCalledTimes(1);
    expect(writeHint).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "suspend", online: true }),
    );

    mocks.isOnline.mockReturnValue(false);
    monitor.emit("resume");
    expect(writeHint.mock.calls.map((call) => call[0].kind)).toEqual([
      "suspend",
      "offline",
      "resume",
    ]);
    mocks.isOnline.mockReturnValue(true);
  });

  it("writes the hint inside the power event handler, before it returns", () => {
    writeHint.mockClear();
    startDesktopConnectivitySignals(options);
    let handlerReturned = false;
    writeHint.mockImplementationOnce(() => {
      expect(handlerReturned).toBe(false);
      return true;
    });
    mocks.powerMonitor!.emit("suspend");
    handlerReturned = true;
    expect(writeHint).toHaveBeenCalledTimes(1);
  });
});
