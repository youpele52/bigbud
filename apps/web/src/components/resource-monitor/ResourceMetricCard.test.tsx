import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { formatHistoryTooltipValue } from "./ResourceMetricHistory.logic";
import { ResourceMetricCard } from "./ResourceMetricCard";
import { displayWidget } from "./resourceMonitor.display";
import type { MonitorSnapshot } from "@bigbud/contracts/system-monitor/types";

describe("resource metric history tooltip values", () => {
  it("keeps missing samples unavailable instead of displaying them as zero", () => {
    expect(formatHistoryTooltipValue(null, (value) => value.toFixed(2))).toBe("—");
    expect(formatHistoryTooltipValue(undefined, (value) => value.toFixed(2))).toBe("—");
  });
});

describe("network metric card", () => {
  it.each([false, true])("labels both chart-colored directions (large: %s)", (large) => {
    const metric = displayWidget(
      {
        networkReceivedBytesPerSecond: { value: 1_024, status: "ready", sampledAtMs: 1 },
        networkTransmittedBytesPerSecond: { value: 2_048, status: "ready", sampledAtMs: 1 },
      } as unknown as MonitorSnapshot,
      "network",
    );
    const markup = renderToStaticMarkup(<ResourceMetricCard metric={metric} large={large} />);

    expect(markup).toContain("Network transfer rates");
    expect(markup).toContain("Download");
    expect(markup).toContain("Upload");
    expect(markup).toContain("1.00 KiB/s");
    expect(markup).toContain("2.00 KiB/s");
    expect(markup).toContain("text-(--chart-2)");
    expect(markup).toContain("text-(--chart-4)");
    expect(markup).not.toContain("↓ 1.00 KiB/s · ↑ 2.00 KiB/s");
  });

  it("retains direction labels while rates are unavailable", () => {
    const markup = renderToStaticMarkup(
      <ResourceMetricCard metric={displayWidget(null, "network")} />,
    );

    expect(markup).toContain("Download");
    expect(markup).toContain("Upload");
    expect(markup.match(/<dd[^>]*>—<\/dd>/g)).toHaveLength(2);
    expect(markup).toContain("warming");
  });
});
