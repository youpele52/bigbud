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
  },
  inclusive: { role: "tools", processCount: 1 },
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
    expect(second).toBe(first);
    const fresh = {
      ...base,
      sequence: 6,
      sampledAtMs: 6000,
      appResources: { ...app, sampledAtMs: 6000 },
    };
    expect(nextAppHistory(base, fresh, first, true).cpu).toHaveLength(2);
  });
  it("resets on registry changes, transport gaps, partial and stale measurements", () => {
    const first = nextAppHistory(null, base, EMPTY_APP_HISTORY, false);
    const changed = { ...base, appResources: { ...app, generation: 2, sampledAtMs: 6000 } };
    expect(nextAppHistory(base, changed, first, true).cpu).toHaveLength(1);
    expect(nextAppHistory(base, base, first, false).cpu).toHaveLength(1);
    expect(nextAppHistory(base, { ...base, sampledAtMs: 12000 }, first, true)).toEqual(
      EMPTY_APP_HISTORY,
    );
    expect(
      nextAppHistory(base, { ...base, appResources: { ...app, incomplete: true } }, first, true),
    ).toEqual(EMPTY_APP_HISTORY);
  });
});
