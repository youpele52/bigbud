import "../../index.css";

import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ResourceMetricCard } from "./ResourceMetricCard";

it("renders readable storage values and a donut in a compact card", async () => {
  const screen = await render(
    <div style={{ width: 240 }}>
      <ResourceMetricCard
        metric={{
          label: "Disk",
          value: "310.00 GiB free",
          status: "ready",
          detail: "500.00 GiB total · Macintosh HD",
          diskUsage: { totalBytes: 500 * 1024 ** 3, freeBytes: 310 * 1024 ** 3 },
        }}
      />
    </div>,
  );
  await expect
    .element(
      screen.getByRole("figure", {
        name: "Storage usage: 38.00% used, 190.00 GiB used, 310.00 GiB free, 500.00 GiB total",
      }),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("group", { name: "Storage breakdown" })).toBeVisible();
  await expect.element(screen.getByText("38.00%", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("190.00 GiB", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("310.00 GiB", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("500.00 GiB total · Macintosh HD", { exact: true }))
    .toBeVisible();
  const chartBounds = screen
    .getByRole("figure", {
      name: "Storage usage: 38.00% used, 190.00 GiB used, 310.00 GiB free, 500.00 GiB total",
    })
    .element()
    .getBoundingClientRect();
  const breakdownBounds = screen
    .getByRole("group", { name: "Storage breakdown" })
    .element()
    .getBoundingClientRect();
  expect(chartBounds.width).toBeGreaterThan(breakdownBounds.width * 1.8);
  expect(document.querySelectorAll(".recharts-pie-sector")).toHaveLength(2);
  const chart = screen.getByRole("application");
  const chartContainerBounds = chart.element().getBoundingClientRect();
  await chart.hover({
    position: { x: chartContainerBounds.width / 2, y: chartContainerBounds.height * 0.8 },
  });
  await expect.element(screen.getByText("62.00%", { exact: true })).toBeVisible();
  expect(document.querySelector(".recharts-tooltip-wrapper")?.textContent).toContain("Free");
  expect(document.querySelector(".recharts-tooltip-wrapper")?.textContent).toContain("310.00 GiB");
});
