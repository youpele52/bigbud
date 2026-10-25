import "../../index.css";

import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ResourceMetricCard } from "./ResourceMetricCard";
import { formatRate } from "./resourceMonitor.format";

it.each([
  { width: 240, large: false },
  { width: 350, large: true },
])("matches rate arrows to chart colors at $width px", async ({ width, large }) => {
  const screen = await render(
    <div style={{ width }}>
      <ResourceMetricCard
        large={large}
        metric={{
          label: "Network",
          value: "↓ 59.71 KiB/s · ↑ 56.35 KiB/s",
          status: "ready",
          networkRates: { download: "59.71 KiB/s", upload: "56.35 KiB/s" },
          historyStyle: "network",
          historyValueFormatter: formatRate,
          history: [
            { sequence: 1, value: 61_143, sentValue: -57_702 },
            { sequence: 2, value: 30_000, sentValue: -40_000 },
          ],
        }}
      />
    </div>,
  );

  const rateReadings = screen.getByRole("group", { name: "Network transfer rates" });
  await expect.element(rateReadings.getByText("Download", { exact: true })).toBeVisible();
  await expect.element(rateReadings.getByText("Upload", { exact: true })).toBeVisible();
  await expect.element(rateReadings.getByText("59.71 KiB/s", { exact: true })).toBeVisible();
  await expect.element(rateReadings.getByText("56.35 KiB/s", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("img", { name: "Network history" })).toBeVisible();

  const rates = rateReadings.element();
  const arrows = rates.querySelectorAll("svg");
  const chartLines = document.querySelectorAll(".recharts-area-curve");
  expect(arrows).toHaveLength(2);
  expect(chartLines).toHaveLength(2);
  for (let index = 0; index < arrows.length; index++) {
    expect(getComputedStyle(arrows[index]!).color).toBe(
      getComputedStyle(chartLines[index]!).stroke,
    );
  }
  expect(getComputedStyle(arrows[0]!).color).not.toBe(getComputedStyle(arrows[1]!).color);
  expect(rates.scrollWidth).toBeLessThanOrEqual(rates.clientWidth);

  const chart = screen.getByRole("application");
  const bounds = chart.element().getBoundingClientRect();
  await chart.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
  const history = screen.getByRole("img", { name: "Network history" }).element();
  const tooltipText = () => history.querySelector(".recharts-tooltip-wrapper")?.textContent;
  await expect.poll(tooltipText).toContain("Download");
  await expect.poll(tooltipText).toContain("Upload");
  await expect.poll(tooltipText).toContain("29.30 KiB/s");
  await expect.poll(tooltipText).toContain("39.06 KiB/s");
  expect(tooltipText()).not.toContain("Received");
  expect(tooltipText()).not.toContain("Sent");
  expect(tooltipText()).not.toContain("-39.06");
});
