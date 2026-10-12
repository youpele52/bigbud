import "../../index.css";

import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ResourceMetricCard } from "./ResourceMetricCard";

it.each(
  ["Disk", "Memory"].flatMap((label) => [
    { label, large: false, theme: "light" },
    { label, large: true, theme: "light" },
    { label, large: false, theme: "dark" },
    { label, large: true, theme: "dark" },
  ]),
)(
  "renders capacity readings with a memory gauge and disk bar (%s)",
  async ({ label, large, theme }) => {
    const footer =
      label === "Disk"
        ? ["Free: 21.90 GiB", "Macintosh HD (/)"]
        : ["Available: 21.90 GiB", "Swap: 1.00 GiB used / 2.00 GiB total"];
    const screen = await render(
      <div className={theme} style={{ width: large ? 480 : 240 }}>
        <ResourceMetricCard
          large={large}
          metric={{
            label,
            value: "unused",
            status: "ready",
            capacityUsage: { totalBytes: 500 * 1024 ** 3, usedBytes: 478.1 * 1024 ** 3, footer },
          }}
        />
      </div>,
    );
    try {
      await expect
        .element(screen.getByRole("meter", { name: `${label} capacity used` }))
        .toBeVisible();
      await expect.element(screen.getByText("95.62%", { exact: false })).toBeVisible();
      if (label === "Disk") await expect.element(screen.getByText("Critical usage")).toBeVisible();
      await expect.element(screen.getByText("478.10 GiB / 500.00 GiB")).toBeVisible();
      for (const line of footer) await expect.element(screen.getByText(line)).toBeVisible();
      const meter = screen.getByRole("meter").element();
      expect(meter.getAttribute("aria-valuenow")).toBe("95.62");
      expect(document.querySelectorAll(".recharts-pie-sector")).toHaveLength(0);
      if (label === "Memory") {
        expect(screen.getByRole("meter").element().getAttribute("aria-valuetext")).toContain(
          "Critical usage",
        );
        expect(
          screen.getByText("478.10 GiB / 500.00 GiB").element().getAttribute("data-slot"),
        ).toBe("badge");
        expect(
          screen
            .getByText("478.10 GiB / 500.00 GiB")
            .element()
            .closest('[data-slot="card-header"]'),
        ).not.toBeNull();
        expect(
          screen.getByRole("meter").element().closest('[data-slot="card"]')!.textContent,
        ).not.toContain("Critical usage");
        expect(meter.querySelectorAll('[data-slot="gauge-segment"]')).toHaveLength(40);
        expect(meter.querySelector('[data-slot="gauge-needle"]')).not.toBeNull();
        await expect.element(screen.getByText("of total host RAM")).toBeVisible();
      } else {
        expect(meter.firstElementChild?.classList.contains("bg-red-500")).toBe(true);
        expect(meter.getBoundingClientRect().height).toBe(8);
        expect(meter.getBoundingClientRect().width).toBeCloseTo(
          meter.parentElement!.getBoundingClientRect().width,
        );
      }
      if (label === "Disk") {
        const readoutStyle = getComputedStyle(
          screen.getByText("478.10 GiB / 500.00 GiB").element(),
        );
        expect(readoutStyle.borderWidth).toBe("0px");
        expect(readoutStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(readoutStyle.padding).toBe("0px");
        expect(readoutStyle.borderRadius).toBe("0px");
      }
      expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
    } finally {
      await screen.unmount();
    }
  },
);

it("keeps missing memory totals unavailable, preserves footers, and suppresses memory history", async () => {
  const screen = await render(
    <ResourceMetricCard
      metric={{
        label: "Memory",
        value: "unused",
        status: "ready",
        history: [
          { sequence: 1, value: 1 },
          { sequence: 2, value: 2 },
        ],
        capacityUsage: {
          usedBytes: 8 * 1024 ** 3,
          totalBytes: null,
          footer: ["Available: —", "Swap: 1.00 GiB used / 2.00 GiB total"],
        },
      }}
    />,
  );
  try {
    await expect
      .element(screen.getByRole("img", { name: "Memory capacity unavailable" }))
      .toBeVisible();
    expect(
      screen
        .getByRole("img", { name: "Memory capacity unavailable" })
        .element()
        .getAttribute("data-state"),
    ).toBe("unavailable");
    await expect.element(screen.getByText("8.00 GiB / —")).toBeVisible();
    await expect.element(screen.getByText("Swap: 1.00 GiB used / 2.00 GiB total")).toBeVisible();
    expect(document.querySelector('[role="meter"]')).toBeNull();
    expect(document.querySelector('[aria-label="Memory history"]')).toBeNull();
  } finally {
    await screen.unmount();
  }
});
