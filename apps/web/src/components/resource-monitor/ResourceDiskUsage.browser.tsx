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
      screen.getByRole("img", {
        name: "310.00 GiB free of 500.00 GiB; 190.00 GiB used",
      }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText("310.00 GiB free of 500.00 GiB", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("38.00%", { exact: true })).toBeVisible();
  expect(document.querySelectorAll(".recharts-pie-sector")).toHaveLength(2);
});
