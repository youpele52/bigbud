import type { MonitorAppResources, MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";
import { EMPTY_APP_HISTORY, nextAppHistory } from "./resourceMonitor.appHistory";

const app: MonitorAppResources = {
  generation: 1,
  sampledAtMs: 1000,
  incomplete: false,
  core: {
    role: "desktop",
    processCount: 1,
    cpuPercent: { value: 10, status: "ready", sampledAtMs: 1000 },
    residentBytes: { value: 1024, status: "ready", sampledAtMs: 1000 },
    readBytesPerSecond: { value: 0, status: "ready", sampledAtMs: 1000 },
    writtenBytesPerSecond: { value: 2048, status: "ready", sampledAtMs: 1000 },
  },
  inclusive: {
    role: "tools",
    processCount: 2,
    cpuPercent: { value: 20, status: "ready", sampledAtMs: 1000 },
    residentBytes: { value: 4096, status: "ready", sampledAtMs: 1000 },
  },
  groups: [],
};
const base = {
  appResources: app,
  sampledAtMs: 1000,
  sequence: 1,
  summaryStatus: "ready",
} as MonitorSnapshot;

describe("app resource history", () => {
  it("does not duplicate retained app samples between host ticks", () => {
    const first = nextAppHistory(null, base, EMPTY_APP_HISTORY, false);
    const second = nextAppHistory(base, { ...base, sequence: 2 }, first, true);
    expect(first.cpu).toHaveLength(1);
    expect(first.inclusiveCpu).toEqual([{ sequence: 1, value: 20 }]);
    expect(first.inclusiveMemory).toEqual([{ sequence: 1, value: 4096 }]);
    expect(first.io).toEqual([{ sequence: 1, value: 0, sentValue: -2048 }]);
    expect(second).toBe(first);
    const fresh = {
      ...base,
      sequence: 6,
      sampledAtMs: 6000,
      appResources: { ...app, sampledAtMs: 6000 },
    };
    const next = nextAppHistory(base, fresh, first, true);
    expect(next.cpu).toHaveLength(2);
    expect(next.io).toHaveLength(2);
    expect(next.inclusiveCpu).toHaveLength(2);
    expect(next.inclusiveMemory).toHaveLength(2);
  });
  it("resets on registry changes, transport gaps, partial and stale measurements", () => {
    const first = nextAppHistory(null, base, EMPTY_APP_HISTORY, false);
    const changed = { ...base, appResources: { ...app, generation: 2, sampledAtMs: 6000 } };
    expect(nextAppHistory(base, changed, first, true).cpu).toHaveLength(1);
    expect(nextAppHistory(base, changed, first, true).io).toHaveLength(1);
    expect(nextAppHistory(base, changed, first, true).inclusiveCpu).toHaveLength(1);
    expect(nextAppHistory(base, base, first, false).inclusiveMemory).toHaveLength(1);
    expect(nextAppHistory(base, base, first, false).cpu).toHaveLength(1);
    expect(nextAppHistory(base, base, first, false).io).toHaveLength(1);
    expect(nextAppHistory(base, { ...base, sampledAtMs: 12000 }, first, true)).toEqual(
      EMPTY_APP_HISTORY,
    );
    expect(
      nextAppHistory(base, { ...base, appResources: { ...app, incomplete: true } }, first, true),
    ).toEqual(EMPTY_APP_HISTORY);
  });
  it("preserves missing I/O directions as gaps and clears fully unavailable rates", () => {
    const first = nextAppHistory(null, base, EMPTY_APP_HISTORY, false);
    const fresh = (core: MonitorAppResources["core"]): MonitorSnapshot => ({
      ...base,
      sequence: 2,
      sampledAtMs: 6000,
      appResources: { ...app, sampledAtMs: 6000, core },
    });
    const unsupported = { value: 0, status: "unsupported" as const, sampledAtMs: 6000 };
    expect(
      nextAppHistory(base, fresh({ ...app.core, readBytesPerSecond: unsupported }), first, true).io,
    ).toEqual([
      { sequence: 1, value: 0, sentValue: -2048 },
      { sequence: 2, value: null, sentValue: -2048 },
    ]);
    expect(
      nextAppHistory(
        base,
        fresh({
          ...app.core,
          writtenBytesPerSecond: { ...app.core.writtenBytesPerSecond!, value: Number.NaN },
        }),
        first,
        true,
      ).io.at(-1),
    ).toEqual({ sequence: 2, value: 0, sentValue: null });
    expect(
      nextAppHistory(
        base,
        fresh({ ...app.core, readBytesPerSecond: unsupported, writtenBytesPerSecond: unsupported }),
        first,
        true,
      ).io,
    ).toEqual([]);
  });
  it("bounds I/O history to the same 300-sample window as Network", () => {
    let previous: MonitorSnapshot | null = null;
    let history = EMPTY_APP_HISTORY;
    for (let sequence = 1; sequence <= 310; sequence++) {
      const sampledAtMs = sequence * 5000;
      const snapshot = {
        ...base,
        sequence,
        sampledAtMs,
        appResources: { ...app, sampledAtMs },
      };
      history = nextAppHistory(previous, snapshot, history, previous !== null);
      previous = snapshot;
    }
    expect(history.io).toHaveLength(300);
    expect(history.inclusiveCpu).toHaveLength(300);
    expect(history.inclusiveMemory[0]?.sequence).toBe(11);
    expect(history.io[0]?.sequence).toBe(11);
    expect(history.io.at(-1)).toEqual({ sequence: 310, value: 0, sentValue: -2048 });
  });
  it("clears only the inclusive metric that is missing or unavailable", () => {
    const first = nextAppHistory(null, base, EMPTY_APP_HISTORY, false);
    const inclusive = { ...app.inclusive };
    delete inclusive.cpuPercent;
    const fresh = {
      ...base,
      sequence: 2,
      sampledAtMs: 6000,
      appResources: {
        ...app,
        sampledAtMs: 6000,
        inclusive: {
          ...inclusive,
          residentBytes: { value: Number.NaN, status: "ready" as const, sampledAtMs: 6000 },
        },
      },
    };
    const next = nextAppHistory(base, fresh, first, true);
    expect(next.cpu).toHaveLength(2);
    expect(next.inclusiveCpu).toEqual([]);
    expect(next.inclusiveMemory).toEqual([]);
    const resumed = nextAppHistory(
      fresh,
      {
        ...base,
        sequence: 3,
        sampledAtMs: 11000,
        appResources: { ...app, sampledAtMs: 11000 },
      },
      next,
      true,
    );
    expect(resumed.inclusiveCpu).toEqual([{ sequence: 3, value: 20 }]);
    expect(resumed.inclusiveMemory).toEqual([{ sequence: 3, value: 4096 }]);
  });
});
