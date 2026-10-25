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
    expect(markup).toContain(">Warming</div>");
  });
});

describe("system capacity gauges", () => {
  it("uses the shared gauge and moves logical cores into the header badge", () => {
    const markup = renderToStaticMarkup(
      <ResourceMetricCard
        metric={{
          label: "CPU",
          value: "47.66%",
          status: "ready",
          gaugeValue: 47.66,
          detail: "10 logical cores",
        }}
      />,
    );
    expect(markup).toContain('data-slot="gauge"');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain('aria-valuenow="47.66"');
    expect(markup.match(/10 logical cores/g)).toHaveLength(1);
  });
  it("shows memory totals in a badge and keeps available/swap details, but not visible severity", () => {
    const markup = renderToStaticMarkup(
      <ResourceMetricCard
        metric={{
          label: "Memory",
          value: "unused",
          status: "ready",
          capacityUsage: {
            usedBytes: 13 * 1024 ** 3,
            totalBytes: 16 * 1024 ** 3,
            footer: ["Available: 3.00 GiB", "Swap: 1.00 GiB used / 2.00 GiB total"],
          },
        }}
      />,
    );
    expect(markup).toContain('data-slot="gauge"');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("13.00 GiB / 16.00 GiB");
    expect(markup).toContain('aria-valuetext="81.25% used · Critical usage"');
    expect(markup).not.toContain(">Critical usage</p>");
    expect(markup).toContain("Available: 3.00 GiB");
    expect(markup).toContain("Swap: 1.00 GiB used / 2.00 GiB total");
  });
  it.each(["ready", "stale", "warming"])(
    "shows system memory history only when measurements are ready (%s)",
    (status) => {
      const markup = renderToStaticMarkup(
        <ResourceMetricCard
          metric={{
            label: "Memory",
            value: "unused",
            status,
            history: [
              { sequence: 1, value: 12 * 1024 ** 3 },
              { sequence: 2, value: 13 * 1024 ** 3 },
            ],
            capacityUsage: { usedBytes: 13 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, footer: [] },
          }}
        />,
      );
      expect(markup.includes('aria-label="Memory history"')).toBe(status === "ready");
    },
  );
});
