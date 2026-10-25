import { describe, expect, it } from "vitest";
import {
  sensorMetric,
  temperatureSnapshot,
} from "~/components/resource-monitor/ResourceTemperatures.fixtures";
import { readyTemperatureValue } from "./resourceMonitor.temperature";
import {
  nextTemperatureHistory,
  temperatureHistoryKey,
} from "./resourceMonitor.temperatureHistory";

describe("sensor temperature histories", () => {
  const base = temperatureSnapshot();
  const sensor = base.temperaturesCelsius[0]!;
  const key = temperatureHistoryKey(sensor);
  const points = [{ sequence: 1, value: 60 }];
  const history = { [key]: points };
  const next = {
    ...base,
    baseline: false,
    sequence: 2,
    temperaturesCelsius: [{ ...sensor, metric: sensorMetric(61, "ready", 2000) }],
  };

  it("collects real per-sensor samples independently", () => {
    expect(nextTemperatureHistory(base, next, history, true)).toEqual({
      [key]: [...points, { sequence: 2, value: 61 }],
    });
    expect(Object.keys(nextTemperatureHistory(null, base, {}, false))).toHaveLength(6);
  });
  it("does not duplicate unchanged slower samples and seeds an empty history after reset", () => {
    expect(nextTemperatureHistory(base, { ...base, sequence: 2 }, history, true)[key]).toBe(points);
    expect(nextTemperatureHistory(base, { ...base, sequence: 2 }, {}, true)[key]).toEqual([
      { sequence: 2, value: 61.64 },
    ]);
  });
  it("bounds samples at 300 and prunes removed sensors", () => {
    expect(
      nextTemperatureHistory(
        base,
        next,
        { [key]: Array.from({ length: 300 }, (_, sequence) => ({ sequence, value: 60 })) },
        true,
      )[key],
    ).toHaveLength(300);
    expect(
      nextTemperatureHistory(base, { ...next, temperaturesCelsius: [] }, history, true),
    ).toEqual({});
  });
  it("resets on lost continuity, stale snapshots and regressed sensor timestamps", () => {
    expect(nextTemperatureHistory(base, next, history, false)[key]).toEqual([
      { sequence: 2, value: 61 },
    ]);
    expect(
      nextTemperatureHistory(base, { ...next, summaryStatus: "stale" }, history, true),
    ).toEqual({});
    expect(
      nextTemperatureHistory(
        base,
        { ...next, temperaturesCelsius: [{ ...sensor, metric: sensorMetric(50, "ready", 500) }] },
        history,
        true,
      )[key],
    ).toHaveLength(1);
  });
  it.each(["stale", "warming", "denied", "unavailable", "unsupported"] as const)(
    "does not fabricate history for %s readings",
    (status) => {
      expect(
        nextTemperatureHistory(
          base,
          { ...next, temperaturesCelsius: [{ ...sensor, metric: sensorMetric(0, status) }] },
          history,
          true,
        ),
      ).toEqual({});
      const unavailable = {
        ...base,
        temperaturesCelsius: [{ ...sensor, metric: sensorMetric(0, status) }],
      };
      expect(nextTemperatureHistory(unavailable, next, {}, true)[key]).toHaveLength(1);
    },
  );
  it.each([-20, 0, 120])("preserves valid signed Celsius values (%s)", (value) => {
    expect(readyTemperatureValue(sensorMetric(value))).toBe(value);
    expect(
      nextTemperatureHistory(
        null,
        { ...base, temperaturesCelsius: [{ ...sensor, metric: sensorMetric(value) }] },
        {},
        false,
      )[key],
    ).toEqual([{ sequence: 1, value }]);
  });
  it.each([NaN, Infinity, -Infinity, -274])(
    "rejects impossible or invalid temperature %s",
    (value) => {
      expect(readyTemperatureValue(sensorMetric(value))).toBeUndefined();
      expect(
        nextTemperatureHistory(
          null,
          { ...base, temperaturesCelsius: [{ ...sensor, metric: sensorMetric(value) }] },
          {},
          false,
        ),
      ).toEqual({});
    },
  );
  it("encodes special sensor names safely", () => {
    expect(
      Object.keys(
        nextTemperatureHistory(
          null,
          { ...base, temperaturesCelsius: [{ ...sensor, name: "__proto__" }] },
          {},
          false,
        ),
      ),
    ).toEqual(['["__proto__"]']);
  });
});
