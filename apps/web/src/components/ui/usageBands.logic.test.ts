import { describe, expect, it } from "vitest";
import { DEFAULT_GAUGE_BANDS, gaugeColor, gaugeReading } from "./gauge.logic";
import { DEFAULT_USAGE_BANDS, usagePercentBand, usagePercentColor } from "./usageBands.logic";

describe("shared percentage palette", () => {
  it("keeps the gauge default palette shared rather than copied", () => {
    expect(DEFAULT_GAUGE_BANDS).toBe(DEFAULT_USAGE_BANDS);
  });
  it.each([
    [-10, "var(--chart-1)", "neutral"],
    [0, "var(--chart-1)", "neutral"],
    [49.999, "var(--chart-1)", "neutral"],
    [50, "var(--chart-3)", "warning"],
    [79.999, "var(--chart-3)", "warning"],
    [80, "var(--chart-4)", "critical"],
    [100, "var(--chart-4)", "critical"],
    [125, "var(--chart-4)", "critical"],
  ] as const)(
    "matches the bounded gauge at %s%% without hiding over-capacity",
    (percent, color, severity) => {
      const reading = gaugeReading(percent, 0, 100)!;
      expect(usagePercentColor(percent)).toBe(color);
      expect(usagePercentColor(percent)).toBe(gaugeColor(reading.fraction, DEFAULT_GAUGE_BANDS));
      expect(usagePercentBand(percent)?.severity).toBe(severity);
    },
  );
  it.each([null, undefined, NaN, Infinity, -Infinity])("leaves %s unavailable", (percent) => {
    expect(usagePercentBand(percent)).toBeUndefined();
    expect(usagePercentColor(percent)).toBe("var(--muted-foreground)");
  });
});
