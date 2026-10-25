import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceCapacityGauge } from "./ResourceCapacityGauge";

describe("CPU capacity gauge", () => {
  it("displays measured usage on the total-host CPU scale", () => {
    const markup = renderToStaticMarkup(
      <ResourceCapacityGauge kind="cpu" usage={{ used: 2.98, total: 100 }} />,
    );
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="2.98"');
    expect(markup).toContain("CPU capacity: 2.98% core bigbud of total host CPU");
    expect(markup).toContain("of total host CPU");
  });
  it.each([
    undefined,
    { used: 101, total: 100 },
    { used: -1, total: 100 },
    { used: Number.NaN, total: 100 },
    { used: 1, total: 0 },
  ])("does not chart invalid CPU measurements", (usage) => {
    const markup = renderToStaticMarkup(<ResourceCapacityGauge kind="cpu" usage={usage} />);
    expect(markup).toContain("CPU capacity: unavailable");
    expect(markup).toContain("Host capacity share unavailable");
    expect(markup).not.toContain('data-slot="gauge-needle"');
    expect(markup).not.toContain("aria-valuenow=");
  });
  it("uses the same gauge for memory without hiding over-capacity estimates", () => {
    const markup = renderToStaticMarkup(
      <ResourceCapacityGauge kind="memory" usage={{ used: 20, total: 16 }} />,
    );
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain('aria-valuetext="125.00%"');
    expect(markup).toContain("Memory capacity: 125.00% core bigbud of total host RAM");
    expect(markup).toContain("Estimate exceeds host RAM");
    expect(markup).toContain("of total host RAM");
  });
});
