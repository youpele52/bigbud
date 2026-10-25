import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Gauge } from "./gauge";

describe("Gauge", () => {
  it("exposes its range and exact value as an accessible meter", () => {
    const markup = renderToStaticMarkup(
      <Gauge
        value={2.98}
        label="CPU usage"
        description="of total host CPU"
        formatValue={(value) => `${value.toFixed(2)}%`}
      />,
    );
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('aria-valuenow="2.98"');
    expect(markup).toContain('aria-valuetext="2.98%"');
    expect(markup).toContain("of total host CPU");
    expect(markup).toContain('data-slot="gauge-needle"');
    expect(markup).not.toMatch(/Low|Moderate|High|Warning/);
  });
  it("allows consumer sizing, custom ranges, colors and segment density", () => {
    const markup = renderToStaticMarkup(
      <Gauge
        label="Temperature"
        value={10}
        min={-20}
        max={40}
        segments={20}
        bands={[{ to: 1, color: "purple" }]}
        className="max-w-80"
        data-testid="temperature"
      />,
    );
    expect(markup).toContain("max-w-80");
    expect(markup).toContain('data-testid="temperature"');
    expect(markup).toContain('aria-valuemin="-20"');
    expect(markup).toContain('aria-valuemax="40"');
    expect(markup.match(/data-slot="gauge-segment"/g)).toHaveLength(20);
    expect(markup).toContain('stroke="purple"');
  });
  it.each([undefined, null, Number.NaN])("does not invent a zero reading for %s", (value) => {
    const markup = renderToStaticMarkup(<Gauge value={value} label="CPU usage" />);
    expect(markup).toContain('data-state="unavailable"');
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain("aria-valuenow=");
    expect(markup).not.toContain('data-slot="gauge-needle"');
    expect(markup).toContain("—");
  });
  it("keeps zero distinct from unavailable and respects reduced motion", () => {
    const markup = renderToStaticMarkup(<Gauge value={0} label="CPU usage" />);
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('data-slot="gauge-needle"');
    expect(markup).not.toContain('data-active="true"');
    expect(markup).toContain("motion-reduce:transition-none");
  });
  it("preserves over-capacity estimate text while bounding the meter and needle", () => {
    const markup = renderToStaticMarkup(
      <Gauge value={125} valueText="125.00%" label="Memory estimate" />,
    );
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain('aria-valuetext="125.00%"');
    expect(markup).toContain("rotate(180deg)");
    expect(markup).toContain(">125.00%</div>");
  });
});
