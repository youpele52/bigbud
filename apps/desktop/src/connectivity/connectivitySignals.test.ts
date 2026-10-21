import type { DesktopConnectivitySignal } from "@bigbud/contracts/server/ipc.desktop.ts";
import { describe, expect, it, vi } from "vitest";

import {
  CONNECTIVITY_COALESCE_MS,
  CONNECTIVITY_ONLINE_POLL_MS,
  CONNECTIVITY_SLEEP_GAP_MS,
  DesktopConnectivitySignals,
  describeConnectivitySignalSupport,
} from "./connectivitySignals";
import { isDesktopConnectivitySignal } from "./connectivitySignals.validation";

type PowerEvent = "suspend" | "resume" | "lock-screen" | "unlock-screen";

function harness(platform: NodeJS.Platform = "darwin") {
  const listeners = new Map<PowerEvent, () => void>();
  const published: DesktopConnectivitySignal[] = [];
  const logs: string[] = [];
  let tick: (() => void) | null = null;
  let online = true;
  let now = 1_000;
  const onResume = vi.fn();
  const clearInterval = vi.fn();
  const signals = new DesktopConnectivitySignals({
    powerMonitor: {
      on: (event, listener) => listeners.set(event, listener),
      removeListener: (event) => listeners.delete(event),
    },
    isOnline: () => online,
    publish: (signal) => published.push(signal),
    log: (message) => logs.push(message),
    platform,
    onResume,
    now: () => now,
    setInterval: (callback) => {
      tick = callback;
      return {};
    },
    clearInterval,
  });
  return {
    signals,
    published,
    logs,
    onResume,
    clearInterval,
    listeners,
    fire: (event: PowerEvent) => listeners.get(event)?.(),
    advance: (ms: number) => {
      now += ms;
    },
    poll: () => tick?.(),
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe("DesktopConnectivitySignals", () => {
  it("publishes all four power events with increasing sequences", () => {
    const h = harness();
    h.signals.start();
    for (const event of ["suspend", "resume", "lock-screen", "unlock-screen"] as const) {
      h.fire(event);
      h.advance(CONNECTIVITY_COALESCE_MS);
    }
    expect(h.published.map((signal) => signal.kind)).toEqual([
      "suspend",
      "resume",
      "lock-screen",
      "unlock-screen",
    ]);
    expect(h.published.map((signal) => signal.sequence)).toEqual([1, 2, 3, 4]);
    expect(h.published.every(isDesktopConnectivitySignal)).toBe(true);
  });

  it("coalesces duplicate events inside the coalescing window", () => {
    const h = harness();
    h.signals.start();
    h.fire("resume");
    h.fire("resume");
    h.advance(CONNECTIVITY_COALESCE_MS - 1);
    h.fire("resume");
    h.advance(1);
    h.fire("resume");
    expect(h.published.filter((signal) => signal.kind === "resume")).toHaveLength(2);
  });

  it("publishes online transitions from the coarse poll only when they change", () => {
    const h = harness();
    h.signals.start();
    h.advance(CONNECTIVITY_ONLINE_POLL_MS);
    h.poll();
    expect(h.published).toEqual([]);
    h.setOnline(false);
    h.advance(CONNECTIVITY_ONLINE_POLL_MS);
    h.poll();
    h.advance(CONNECTIVITY_ONLINE_POLL_MS);
    h.poll();
    h.setOnline(true);
    h.advance(CONNECTIVITY_ONLINE_POLL_MS);
    h.poll();
    expect(h.published.map((signal) => [signal.kind, signal.online])).toEqual([
      ["offline", false],
      ["online", true],
    ]);
  });

  it("polls the network on resume before announcing it, then probes the backend", () => {
    const h = harness();
    h.signals.start();
    h.setOnline(false);
    h.fire("resume");
    expect(h.published.map((signal) => signal.kind)).toEqual(["offline", "resume"]);
    expect(h.published.at(-1)?.online).toBe(false);
    expect(h.onResume).toHaveBeenCalledOnce();
  });

  it("synthesizes a missing resume after a sleep gap and logs it", () => {
    const h = harness("linux");
    h.signals.start();
    h.advance(CONNECTIVITY_SLEEP_GAP_MS + 5_000);
    h.poll();
    expect(h.published.map((signal) => signal.kind)).toEqual(["resume"]);
    expect(h.onResume).toHaveBeenCalledOnce();
    expect(h.logs.some((line) => line.includes("resume signal missing"))).toBe(true);
  });

  it("does not synthesize a resume when the real event arrived", () => {
    const h = harness();
    h.signals.start();
    h.advance(CONNECTIVITY_SLEEP_GAP_MS + 5_000);
    h.fire("resume");
    h.poll();
    expect(h.published.filter((signal) => signal.kind === "resume")).toHaveLength(1);
  });

  it("records platform gaps in the log and stops cleanly", () => {
    const h = harness("linux");
    h.signals.start();
    expect(h.logs[0]).toContain("lock-screen is unsupported");
    expect(describeConnectivitySignalSupport("darwin")).toContain("supported");
    expect(describeConnectivitySignalSupport("win32")).toContain("supported");
    h.signals.stop();
    expect(h.listeners.size).toBe(0);
    expect(h.clearInterval).toHaveBeenCalledOnce();
  });

  it("rejects malformed payloads in the preload validator", () => {
    expect(isDesktopConnectivitySignal(null)).toBe(false);
    expect(
      isDesktopConnectivitySignal({ kind: "reboot", sequence: 1, occurredAt: 1, online: true }),
    ).toBe(false);
    expect(
      isDesktopConnectivitySignal({ kind: "resume", sequence: 1.5, occurredAt: 1, online: true }),
    ).toBe(false);
    expect(
      isDesktopConnectivitySignal({ kind: "resume", sequence: 1, occurredAt: 1, online: "yes" }),
    ).toBe(false);
    expect(
      isDesktopConnectivitySignal({ kind: "resume", sequence: 1, occurredAt: 1, online: null }),
    ).toBe(true);
  });
});
