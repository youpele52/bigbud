import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResourceHostExtras } from "./ResourceHostExtras";

describe("ResourceHostExtras", () => {
  it("shows Rust's optional host values and explicit unavailable states", () => {
    const snapshot = {
      kernelVersion: "Darwin 25",
      cpuBrand: "Example CPU",
      cpuFrequencyMhz: { value: 3200, status: "ready", sampledAtMs: 1 },
      loadAverageOne: { value: 1.25, status: "ready", sampledAtMs: 1 },
      loadAverageFive: { value: 0, status: "unsupported", sampledAtMs: 1 },
      loadAverageFifteen: { value: 0, status: "unsupported", sampledAtMs: 1 },
    } as MonitorSnapshot;
    const markup = renderToStaticMarkup(<ResourceHostExtras snapshot={snapshot} />);
    expect(markup).toContain("Darwin 25");
    expect(markup).toContain("Example CPU");
    expect(markup).toContain("3200.00 MHz");
    expect(markup).toContain("1.25 / unsupported / unsupported");
    expect(markup).toContain("Physical cores: unavailable");
  });
});
