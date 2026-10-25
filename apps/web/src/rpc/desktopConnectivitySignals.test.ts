import type { DesktopConnectivitySignal } from "@bigbud/contracts/server/ipc.desktop.ts";
import { describe, expect, it, vi } from "vitest";

import { subscribeDesktopConnectivitySignals } from "./desktopConnectivitySignals";

function fakeBridge() {
  const listeners = new Set<(signal: DesktopConnectivitySignal) => void>();
  return {
    bridge: {
      onConnectivitySignal: (listener: (signal: DesktopConnectivitySignal) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (kind: DesktopConnectivitySignal["kind"], sequence: number) => {
      for (const listener of listeners) listener({ kind, sequence, occurredAt: 0, online: true });
    },
    listenerCount: () => listeners.size,
  };
}

describe("subscribeDesktopConnectivitySignals", () => {
  it("delivers power and network hints in order and drops replays", () => {
    const desktop = fakeBridge();
    const listener = vi.fn();
    const stop = subscribeDesktopConnectivitySignals(desktop.bridge, listener);
    desktop.emit("suspend", 1);
    desktop.emit("resume", 2);
    desktop.emit("resume", 2);
    desktop.emit("unlock-screen", 1);
    desktop.emit("online", 3);
    expect(listener.mock.calls.map(([signal]) => signal.kind)).toEqual([
      "suspend",
      "resume",
      "online",
    ]);
    stop();
    expect(desktop.listenerCount()).toBe(0);
  });

  it("is a no-op on bridges without connectivity signals", () => {
    const stop = subscribeDesktopConnectivitySignals(undefined, vi.fn());
    expect(() => stop()).not.toThrow();
    expect(subscribeDesktopConnectivitySignals({}, vi.fn())).toBeTypeOf("function");
  });
});
