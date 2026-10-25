import type { MonitorNetworkInterface } from "@bigbud/contracts/system-monitor/types";
import { describe, expect, it } from "vitest";
import {
  interfaceMetric,
  interfaceMonitorSnapshot,
} from "~/components/resource-monitor/ResourceNetworkInterfaces.fixtures";
import { interfaceHistoryKey, nextInterfaceHistory } from "./resourceMonitor.interfaceHistory";

describe("per-interface histories", () => {
  const base = interfaceMonitorSnapshot();
  const item = base.interfaces[0]!;
  const key = interfaceHistoryKey(item);
  const points = [{ sequence: 1, value: 100, sentValue: -200 }];
  const history = { [key]: points };
  const next = {
    ...base,
    sequence: 2,
    baseline: false,
    interfaces: [
      {
        ...item,
        receivedBytesPerSecond: interfaceMetric(0, "ready", 2000),
        transmittedBytesPerSecond: interfaceMetric(300, "ready", 2000),
      },
    ],
  };

  it("records zero and mirrors upload without combining interfaces", () => {
    expect(nextInterfaceHistory(base, next, history, true)).toEqual({
      [key]: [...points, { sequence: 2, value: 0, sentValue: -300 }],
    });
    expect(
      nextInterfaceHistory(null, base, {}, false)[interfaceHistoryKey(base.interfaces[1]!)],
    ).toEqual([{ sequence: 1, value: 0, sentValue: -0 }]);
  });
  it("does not duplicate unchanged samples and prunes removed interfaces", () => {
    expect(nextInterfaceHistory(base, { ...base, sequence: 2 }, history, true)[key]).toBe(points);
    expect(nextInterfaceHistory(base, { ...next, interfaces: [] }, history, true)).toEqual({});
  });
  it("seeds history again after a failure even when the native sample has not changed", () => {
    expect(nextInterfaceHistory(base, { ...base, sequence: 2 }, {}, true)[key]).toEqual([
      {
        sequence: 2,
        value: item.receivedBytesPerSecond!.value,
        sentValue: -item.transmittedBytesPerSecond!.value,
      },
    ]);
  });
  it("resets for stale snapshots, lost continuity, and regressed timestamps", () => {
    expect(nextInterfaceHistory(base, { ...next, summaryStatus: "stale" }, history, true)).toEqual(
      {},
    );
    expect(nextInterfaceHistory(base, next, history, false)[key]).toHaveLength(1);
    expect(
      nextInterfaceHistory(
        base,
        {
          ...next,
          interfaces: [
            { ...next.interfaces[0]!, receivedBytesPerSecond: interfaceMetric(40, "ready", 500) },
          ],
        },
        history,
        true,
      )[key],
    ).toHaveLength(1);
  });
  it("preserves missing directions as gaps and rejects fully unavailable measurements", () => {
    const partial: MonitorNetworkInterface = {
      ...item,
      receivedBytesPerSecond: interfaceMetric(40, "ready", 2000),
    };
    delete partial.transmittedBytesPerSecond;
    expect(
      nextInterfaceHistory(base, { ...next, interfaces: [partial] }, history, true)[key]?.at(-1),
    ).toEqual({ sequence: 2, value: 40, sentValue: null });
    delete partial.receivedBytesPerSecond;
    expect(nextInterfaceHistory(base, { ...next, interfaces: [partial] }, history, true)).toEqual(
      {},
    );
  });
  it("bounds each history at 300 points and safely encodes special names", () => {
    expect(
      nextInterfaceHistory(
        base,
        next,
        { [key]: Array.from({ length: 300 }, (_, sequence) => ({ sequence, value: 0 })) },
        true,
      )[key],
    ).toHaveLength(300);
    const result = nextInterfaceHistory(
      null,
      { ...base, interfaces: [{ ...item, name: "__proto__" }] },
      {},
      false,
    );
    expect(Object.keys(result)).toEqual(['["__proto__"]']);
  });
});
