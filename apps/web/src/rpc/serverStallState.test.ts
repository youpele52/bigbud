import type { ServerLifecycleStreamEvent } from "@bigbud/contracts/server/server.lifecycle.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appAtomRegistry } from "./atomRegistry";
import { startServerConfigSync } from "./serverState.configSync";
import {
  recordServerStall,
  resetServerStallStateForTests,
  serverStallAtom,
} from "./serverStallState";

afterEach(() => {
  resetServerStallStateForTests();
});

const payload = {
  startedAt: "2026-10-21T15:00:00.000Z",
  endedAt: "2026-10-21T15:01:15.000Z",
  durationMs: 75_000,
  spans: [],
  inFlightRpcMethods: [],
};

describe("server stall state", () => {
  it("routes lifecycle stalled events to the stall callback without touching welcome", () => {
    const lifecycleListeners: Array<(event: ServerLifecycleStreamEvent) => void> = [];
    const emitWelcome = vi.fn();
    const emitStalled = vi.fn();
    const stop = startServerConfigSync(
      {
        getConfig: vi.fn(() => new Promise(() => undefined)),
        subscribeConfig: vi.fn(() => () => undefined),
        subscribeLifecycle: vi.fn((listener) => {
          lifecycleListeners.push(listener);
          return () => undefined;
        }),
      } as never,
      {
        getConfig: () => null,
        setSnapshot: vi.fn(),
        applyEvent: vi.fn(),
        emitWelcome,
        emitStalled,
      },
    );
    for (const listener of lifecycleListeners) {
      listener({ version: 1, sequence: 4, type: "stalled", payload });
    }
    expect(emitStalled).toHaveBeenCalledWith(payload);
    expect(emitWelcome).not.toHaveBeenCalled();
    stop();
  });

  it("counts a stall replayed by the lifecycle snapshot only once", () => {
    recordServerStall(payload);
    const first = appAtomRegistry.get(serverStallAtom);
    // Each resubscribe replays the snapshot, which still contains the same stall.
    recordServerStall({ ...payload, spans: [] });
    expect(appAtomRegistry.get(serverStallAtom)).toBe(first);

    const later = {
      ...payload,
      startedAt: "2026-10-21T15:05:00.000Z",
      endedAt: "2026-10-21T15:05:20.000Z",
    };
    recordServerStall(later);
    const second = appAtomRegistry.get(serverStallAtom);
    expect(second?.payload).toEqual(later);
    expect(second?.id).toBeGreaterThan(first?.id ?? 0);
  });
});
