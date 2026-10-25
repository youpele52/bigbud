import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import { displayWidget } from "./resourceMonitor.display";
import { ResourceMetricCard } from "./ResourceMetricCard";

function metric(value: number) {
  return { value, status: "ready" as const, sampledAtMs: 1000 };
}
afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 340, dark: true },
  { width: 896, dark: true },
  { width: 896, dark: false },
])(
  "aligns system gauge headers without overflow ($width px, dark: $dark)",
  async ({ width, dark }) => {
    await page.viewport(1100, 1400);
    document.documentElement.classList.toggle("dark", dark);
    const snapshot = {
      ...appMonitorSnapshot(),
      cpuPercent: metric(47.66),
      perCorePercent: Array.from({ length: 10 }, (_, index) => ({
        name: `Core ${index}`,
        metric: metric(47.66),
      })),
      memoryTotalBytes: metric(64 * 1024 ** 3),
      memoryUsedBytes: metric(53.22 * 1024 ** 3),
      memoryAvailableBytes: metric(26.68 * 1024 ** 3),
      swapUsedBytes: metric(1.52 * 1024 ** 3),
      swapTotalBytes: metric(2 * 1024 ** 3),
    };
    const cpu = displayWidget(snapshot, "cpu");
    const cpuHistory = Array.from({ length: 30 }, (_, sequence) => ({
      sequence,
      value: 40 + sequence / 3,
    }));
    cpu.history = cpuHistory;
    const memory = displayWidget(snapshot, "memory");
    memory.history = cpuHistory.map(({ sequence, value }) => ({
      sequence,
      value: (value + 5) * 1024 ** 3,
    }));
    const screen = await render(
      <div
        className="@container bg-background p-4 text-foreground"
        style={{ width }}
        data-testid="surface"
      >
        <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
          <ResourceMetricCard metric={cpu} large />
          <ResourceMetricCard metric={memory} large />
        </div>
      </div>,
    );
    const cpuGauge = screen.getByRole("meter", { name: "CPU usage", exact: true });
    const memoryGauge = screen.getByRole("meter", { name: "Memory capacity used", exact: true });
    await expect.element(cpuGauge).toBeVisible();
    await expect.element(memoryGauge).toBeVisible();
    const cpuBadge = screen.getByText("10 logical cores").element();
    const memoryBadge = screen.getByText("53.22 GiB / 64.00 GiB").element();
    for (const badge of [cpuBadge, memoryBadge]) {
      expect(badge.getAttribute("data-slot")).toBe("badge");
      expect(badge.closest('[data-slot="card-header"]')).not.toBeNull();
    }
    await expect.element(screen.getByText("Available: 26.68 GiB")).toBeVisible();
    await expect.element(screen.getByText("Swap: 1.52 GiB used / 2.00 GiB total")).toBeVisible();
    expect(memoryGauge.element().closest('[data-slot="card"]')!.textContent).not.toContain(
      "High usage",
    );
    expect(memoryGauge.element().getAttribute("aria-valuetext")).toContain("Critical usage");
    const history = screen.getByRole("img", { name: "CPU history", exact: true });
    await expect.element(history).toBeVisible();
    const memoryHistory = screen.getByRole("img", { name: "Memory history", exact: true });
    await expect.element(memoryHistory).toBeVisible();
    expect(memoryHistory.element().getBoundingClientRect().height).toBe(112);
    expect(memoryHistory.element().getBoundingClientRect().top).toBeGreaterThan(
      screen.getByText("Swap: 1.52 GiB used / 2.00 GiB total").element().getBoundingClientRect()
        .bottom,
    );
    const chart = memoryHistory.getByRole("application");
    const bounds = chart.element().getBoundingClientRect();
    await chart.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
    await expect
      .poll(() => memoryHistory.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
      .toContain("GiB");
    if (width === 896)
      expect(history.element().getBoundingClientRect().top).toBe(
        memoryHistory.element().getBoundingClientRect().top,
      );
    expect(history.element().getBoundingClientRect().top).toBeGreaterThan(
      cpuGauge.element().getBoundingClientRect().bottom,
    );
    if (width === 896)
      expect(cpuGauge.element().getBoundingClientRect().top).toBe(
        memoryGauge.element().getBoundingClientRect().top,
      );
    const surface = screen.getByTestId("surface");
    expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
    const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
    if (directory)
      await surface.screenshot({
        path: `${directory}/system-gauges-${width}-${dark ? "dark" : "light"}.png`,
      });
    await screen.unmount();
  },
);
