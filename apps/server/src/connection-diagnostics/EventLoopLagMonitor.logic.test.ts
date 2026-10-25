import { describe, expect, it } from "vitest";

import {
  buildStalledPayload,
  classifyLoopGap,
  type LoopClockReading,
  loopSleepClockForPlatform,
  shouldRetainEventLoopWindow,
  summarizeEventLoopWindow,
} from "./EventLoopLagMonitor.logic.ts";

/** Clock reading where wall and monotonic time move together and CPU time is given. */
const at = (ms: number, cpuMs = 0): LoopClockReading => ({
  monotonicMs: ms,
  wallMs: 1_700_000_000_000 + ms,
  cpuMs,
});

describe("classifyLoopGap", () => {
  it("ignores normal timer jitter below the threshold", () => {
    expect(classifyLoopGap({ previous: at(0), now: at(250), intervalMs: 250 })).toBeNull();
    expect(classifyLoopGap({ previous: at(0), now: at(1_249), intervalMs: 250 })).toBeNull();
  });

  it("reports a stall once the extra delay reaches the threshold", () => {
    expect(classifyLoopGap({ previous: at(1_000), now: at(2_250), intervalMs: 250 })).toEqual({
      kind: "stall",
      startedAtMonotonicMs: 1_250,
      durationMs: 1_000,
    });
    expect(classifyLoopGap({ previous: at(0), now: at(75_250), intervalMs: 250 })?.durationMs).toBe(
      75_000,
    );
  });

  it("honors a custom threshold", () => {
    expect(
      classifyLoopGap({ previous: at(0), now: at(400), intervalMs: 250, thresholdMs: 100 }),
    ).toEqual({ kind: "stall", startedAtMonotonicMs: 250, durationMs: 150 });
  });

  it("treats a long idle gap as system sleep where the monotonic clock counts sleep", () => {
    expect(
      classifyLoopGap({
        previous: at(0, 1_000),
        now: at(600_250, 1_020),
        intervalMs: 250,
        monotonicIncludesSleep: true,
      }),
    ).toEqual({ kind: "system-sleep", durationMs: 600_000 });
  });

  it("keeps a long gap that burned CPU as a stall, even on Windows", () => {
    expect(
      classifyLoopGap({
        previous: at(0, 1_000),
        now: at(94_250, 80_000),
        intervalMs: 250,
        monotonicIncludesSleep: true,
      })?.kind,
    ).toBe("stall");
  });

  it("keeps short idle gaps and disagreeing clocks as stalls", () => {
    const short = classifyLoopGap({
      previous: at(0),
      now: at(5_250),
      intervalMs: 250,
      monotonicIncludesSleep: true,
    });
    expect(short?.kind).toBe("stall");
    const wallJumped = classifyLoopGap({
      previous: at(0),
      now: { ...at(60_250), wallMs: at(60_250).wallMs + 3_600_000 },
      intervalMs: 250,
      monotonicIncludesSleep: true,
    });
    expect(wallJumped?.kind).toBe("stall");
  });

  it("never treats a gap as sleep where the monotonic clock stops during sleep", () => {
    expect(classifyLoopGap({ previous: at(0), now: at(600_250), intervalMs: 250 })?.kind).toBe(
      "stall",
    );
  });

  it("classifies a macOS lid close as sleep, not a stall", () => {
    // mach_continuous_time counts sleep: both clocks jump together and no CPU is spent.
    const darwin = loopSleepClockForPlatform("darwin");
    expect(darwin).toEqual({ monotonicIncludesSleep: true, boottimeCountsSleep: false });
    expect(
      classifyLoopGap({ previous: at(0), now: at(600_250), intervalMs: 250, ...darwin }),
    ).toEqual({ kind: "system-sleep", durationMs: 600_000 });
  });

  it("classifies a Linux suspend from boot time running ahead of monotonic time", () => {
    const linux = loopSleepClockForPlatform("linux");
    // CLOCK_MONOTONIC stops during suspend; CLOCK_BOOTTIME and the wall clock keep counting.
    const previous = { monotonicMs: 0, wallMs: 1_700_000_000_000, cpuMs: 0, boottimeMs: 5_000 };
    const now = {
      monotonicMs: 250,
      wallMs: 1_700_000_000_000 + 600_250,
      cpuMs: 1,
      boottimeMs: 5_000 + 600_250,
    };
    expect(classifyLoopGap({ previous, now, intervalMs: 250, ...linux })).toEqual({
      kind: "system-sleep",
      durationMs: 600_000,
    });
  });

  it("never treats a Linux wall-clock step without a suspend as sleep", () => {
    const linux = loopSleepClockForPlatform("linux");
    const previous = { monotonicMs: 0, wallMs: 1_700_000_000_000, cpuMs: 0, boottimeMs: 5_000 };
    const now = {
      monotonicMs: 250,
      wallMs: 1_700_000_000_000 + 3_600_000,
      cpuMs: 1,
      boottimeMs: 5_250,
    };
    expect(classifyLoopGap({ previous, now, intervalMs: 250, ...linux })).toBeNull();
  });
});

describe("shouldRetainEventLoopWindow", () => {
  const window = { endedAt: new Date(0).toISOString(), windowMs: 10_000, stallCount: 0 };

  it("drops healthy windows and keeps lagging ones", () => {
    expect(shouldRetainEventLoopWindow({ ...window, p50Ms: 20, p99Ms: 30, maxMs: 90 })).toBe(false);
    expect(shouldRetainEventLoopWindow({ ...window, p50Ms: 20, p99Ms: 30, maxMs: 140 })).toBe(true);
    expect(shouldRetainEventLoopWindow({ ...window, p50Ms: 20, p99Ms: 60, maxMs: 90 })).toBe(true);
    expect(
      shouldRetainEventLoopWindow({ ...window, p50Ms: 0, p99Ms: 0, maxMs: 0, stallCount: 1 }),
    ).toBe(true);
  });
});

describe("buildStalledPayload", () => {
  it("lists running spans and in-flight RPC methods with bounds", () => {
    const runningSpans = [
      { name: "sql.execute", startedAtMs: 9_900, endedAtMs: 12_000 },
      { name: "ws.rpc.server.getUsageSummary", startedAtMs: 9_800, endedAtMs: null },
      { name: "ws.rpc.server.getUsageSummary", startedAtMs: 9_700, endedAtMs: null },
      ...Array.from({ length: 10 }, (_, index) => ({
        name: `ws.rpc.method${index}`,
        startedAtMs: 1_000 - index,
        endedAtMs: null,
      })),
    ];
    const payload = buildStalledPayload({ endedAtMs: 12_000, durationMs: 2_000.4, runningSpans });

    expect(payload.durationMs).toBe(2_000);
    expect(payload.startedAt).toBe(new Date(10_000).toISOString());
    expect(payload.endedAt).toBe(new Date(12_000).toISOString());
    expect(payload.spans).toHaveLength(8);
    expect(payload.spans[0]).toEqual({
      name: "sql.execute",
      startedAt: new Date(9_900).toISOString(),
      endedAt: new Date(12_000).toISOString(),
    });
    expect(payload.inFlightRpcMethods[0]).toBe("server.getUsageSummary");
    expect(new Set(payload.inFlightRpcMethods).size).toBe(payload.inFlightRpcMethods.length);
    expect(payload.inFlightRpcMethods).toHaveLength(8);
  });
});

describe("summarizeEventLoopWindow", () => {
  it("converts histogram nanoseconds into rounded milliseconds", () => {
    const window = summarizeEventLoopWindow({
      histogram: {
        percentile: (percentile) => (percentile === 99 ? 45_678_900 : 21_000_000),
        max: 1_234_560_000,
      },
      endedAtMs: 0,
      windowMs: 10_003.7,
      stallCount: 1,
    });

    expect(window).toEqual({
      endedAt: new Date(0).toISOString(),
      windowMs: 10_004,
      p50Ms: 21,
      p99Ms: 45.7,
      maxMs: 1_234.6,
      stallCount: 1,
    });
  });
});
