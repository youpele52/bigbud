import { describe, expect, it } from "vitest";
import { DEFAULT_GAUGE_BANDS, gaugeColor, gaugeReading, gaugeSegments } from "./gauge.logic";

describe("gauge geometry", () => {
  it.each([
    [0, 0],
    [50, 90],
    [100, 180],
  ])("maps %s to a %s degree needle", (value, angle) => {
    expect(gaugeReading(value, 0, 100)?.angle).toBe(angle);
  });
  it("supports custom ranges and clamps only finite out-of-range values", () => {
    expect(gaugeReading(0, -50, 50)?.fraction).toBe(0.5);
    expect(gaugeReading(-10, 0, 100)?.value).toBe(0);
    expect(gaugeReading(120, 0, 100)?.value).toBe(100);
  });
  it.each([undefined, null, Number.NaN, Infinity, -Infinity])("leaves %s unavailable", (value) => {
    expect(gaugeReading(value, 0, 100)).toBeUndefined();
  });
  it.each([
    [0, 0],
    [100, 0],
    [0, Infinity],
    [Number.NaN, 100],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ])("rejects invalid range %s to %s", (min, max) => {
    expect(gaugeReading(10, min, max)).toBeUndefined();
  });
  it("lays out bounded segments across the upper semicircle", () => {
    const segments = gaugeSegments(40);
    expect(segments).toHaveLength(40);
    expect(segments[0]?.x2).toBe(30);
    expect(segments[0]?.y2).toBeCloseTo(108);
    expect(segments.at(-1)?.x2).toBe(210);
    expect(segments.at(-1)?.y2).toBe(108);
    expect(segments.every((segment) => segment.y2 <= 108)).toBe(true);
    expect(gaugeSegments(-1)).toHaveLength(8);
    expect(gaugeSegments(1000)).toHaveLength(80);
    expect(gaugeSegments(Number.NaN)).toHaveLength(40);
  });
  it("supports caller-defined color bands without inventing severity labels", () => {
    expect(gaugeColor(0.2, DEFAULT_GAUGE_BANDS)).toBe("var(--chart-1)");
    expect(gaugeColor(0.7, DEFAULT_GAUGE_BANDS)).toBe("var(--chart-3)");
    expect(gaugeColor(0.9, DEFAULT_GAUGE_BANDS)).toBe("var(--chart-4)");
    expect(gaugeColor(0.5, [{ to: 1, color: "purple" }])).toBe("purple");
    expect(gaugeColor(0.5, [])).toBe("var(--chart-1)");
  });
});
