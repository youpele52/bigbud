import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { BigbudResourceView } from "./BigbudResourceView";
import { MonitorScopeToggle } from "./MonitorScopeToggle";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import { useResourceMonitor } from "./useResourceMonitor";
import { EMPTY_APP_HISTORY } from "~/stores/resource-monitor/resourceMonitor.appHistory";

vi.mock("./useResourceMonitor", () => ({ useResourceMonitor: vi.fn() }));
afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 340, large: false, dark: true },
  { width: 896, large: true, dark: true },
  { width: 896, large: true, dark: false },
])(
  "shows core/inclusive usage and histories without overflowing a $width px surface (dark: $dark)",
  async ({ width, large, dark }) => {
    await page.viewport(1100, 2000);
    document.documentElement.classList.toggle("dark", dark);
    const points = Array.from({ length: 30 }, (_, sequence) => ({
      sequence,
      value: 2 + (sequence % 8),
    }));
    vi.mocked(useResourceMonitor).mockReturnValue({
      snapshot: appMonitorSnapshot(),
      history: { cpu: [], memory: [], network: [] },
      appHistory: {
        cpu: points,
        memory: points.map(({ sequence, value }) => ({ sequence, value: (value * 1024 ** 3) / 8 })),
        io: points.map(({ sequence, value }) => ({
          sequence,
          value: value * 1024,
          sentValue: -value * 2048,
        })),
        inclusiveCpu: points.map(({ sequence, value }) => ({ sequence, value: value * 2 })),
        inclusiveMemory: points.map(({ sequence, value }) => ({
          sequence,
          value: value * 1024 ** 3,
        })),
      },
      appReason: null,
      connection: "connected",
      reason: null,
      collectionStatus: null,
    });
    const screen = await render(
      <div
        className="space-y-3 bg-background p-4 text-foreground"
        style={{ width }}
        data-testid="monitor-surface"
      >
        <MonitorScopeToggle scope="bigbud" onScopeChange={() => undefined} />
        <BigbudResourceView visible large={large} />
      </div>,
    );
    await expect
      .element(screen.getByRole("img", { name: "CPU history", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "Memory history", exact: true }))
      .toBeVisible();
    for (const label of ["CPU", "Memory"]) {
      const trend = screen.getByRole("img", { name: `Including agents/tools ${label} history` });
      await expect.element(trend).toBeVisible();
      expect(trend.element().getBoundingClientRect().height).toBe(large ? 112 : 80);
      const chart = trend.getByRole("application");
      const bounds = chart.element().getBoundingClientRect();
      await chart.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
      await expect
        .poll(() => trend.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
        .toContain(label === "CPU" ? "%" : "GiB");
      expect(trend.element().querySelector("linearGradient")).not.toBeNull();
    }
    const ioHistory = screen.getByRole("img", { name: "Disk I/O history" });
    await expect.element(ioHistory).toBeVisible();
    expect(ioHistory.element().getBoundingClientRect().height).toBe(large ? 112 : 48);
    const ioRates = screen.getByRole("group", { name: "I/O transfer rates" });
    await expect.element(ioRates.getByText("Read", { exact: true })).toBeVisible();
    await expect.element(ioRates.getByText("Write", { exact: true })).toBeVisible();
    await expect.element(ioRates.getByText("0.00 B/s", { exact: true })).toBeVisible();
    await expect.element(ioRates.getByText("2.00 KiB/s", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("12 core processes", { exact: true })).toBeVisible();
    const ioCurves = ioHistory.element().querySelectorAll(".recharts-area-curve");
    expect(ioCurves).toHaveLength(2);
    expect(ioCurves[0]!.getAttribute("stroke")).toBe("var(--chart-2)");
    expect(ioCurves[1]!.getAttribute("stroke")).toBe("var(--chart-4)");
    const arrows = ioRates.element().querySelectorAll("svg");
    expect(arrows).toHaveLength(2);
    for (let index = 0; index < arrows.length; index++) {
      expect(getComputedStyle(arrows[index]!).color).toBe(
        getComputedStyle(ioCurves[index]!).stroke,
      );
    }
    const graphGap =
      ioHistory.element().getBoundingClientRect().top -
      ioRates.element().getBoundingClientRect().bottom;
    expect(graphGap).toBeGreaterThanOrEqual(0);
    expect(graphGap).toBeLessThanOrEqual(8);
    const ioAreas = ioHistory.element().querySelectorAll(".recharts-area-area");
    expect(ioAreas).toHaveLength(2);
    expect(ioAreas[0]!.getAttribute("fill")).toBe("var(--chart-2)");
    expect(ioAreas[1]!.getAttribute("fill")).toBe("var(--chart-4)");
    const ioChart = ioHistory.getByRole("application");
    const ioBounds = ioChart.element().getBoundingClientRect();
    await ioChart.hover({ position: { x: ioBounds.width * 0.8, y: ioBounds.height / 2 } });
    const ioTooltip = () =>
      ioHistory.element().querySelector(".recharts-tooltip-wrapper")?.textContent;
    await expect.poll(ioTooltip).toContain("Read");
    await expect.poll(ioTooltip).toContain("Write");
    expect(ioTooltip()).toContain("KiB/s");
    expect(ioTooltip()).not.toMatch(/-\d/);
    expect(ioTooltip()).not.toContain("Download");
    expect(ioTooltip()).not.toContain("Upload");
    const cpuDonut = screen.getByRole("img", {
      name: "CPU capacity: 4.80% core bigbud of total host CPU",
    });
    const memoryDonut = screen.getByRole("img", {
      name: "Memory capacity: 6.25% core bigbud of total host RAM",
    });
    await expect.element(cpuDonut).toBeVisible();
    await expect.element(memoryDonut).toBeVisible();
    await expect
      .poll(() => cpuDonut.element().querySelectorAll(".recharts-sector").length)
      .toBeGreaterThanOrEqual(3);
    const donutRect = cpuDonut.element().getBoundingClientRect();
    const historyRect = screen
      .getByRole("img", { name: "CPU history", exact: true })
      .element()
      .getBoundingClientRect();
    expect(historyRect.top).toBeGreaterThanOrEqual(donutRect.bottom);
    await expect
      .element(screen.getByRole("heading", { name: "Including agents/tools" }))
      .toBeVisible();
    const ioCard = ioHistory.element().closest('[data-slot="card"]')!.getBoundingClientRect();
    const inclusiveCard = screen
      .getByRole("heading", { name: "Including agents/tools" })
      .element()
      .closest('[data-slot="card"]')!
      .getBoundingClientRect();
    const cpuCard = cpuDonut.element().closest('[data-slot="card"]')!.getBoundingClientRect();
    const memoryCard = memoryDonut.element().closest('[data-slot="card"]')!.getBoundingClientRect();
    expect(ioCard.width).toBe(inclusiveCard.width);
    expect(ioCard.height).toBe(inclusiveCard.height);
    expect(ioCard.width).toBe(cpuCard.width);
    expect(ioCard.left).toBe(cpuCard.left);
    expect(inclusiveCard.left).toBe(memoryCard.left);
    if (width === 340) {
      expect(inclusiveCard.top).toBeGreaterThanOrEqual(ioCard.bottom);
    } else {
      expect(inclusiveCard.top).toBe(ioCard.top);
      expect(inclusiveCard.left).toBeGreaterThanOrEqual(ioCard.right);
    }
    const surface = screen.getByTestId("monitor-surface");
    expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
    const screenshotDirectory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
    if (screenshotDirectory)
      await surface.screenshot({
        path: `${screenshotDirectory}/bigbud-monitor-${width}-${dark ? "dark" : "light"}.png`,
      });
    const pie = cpuDonut.getByRole("application");
    const pieBounds = pie.element().getBoundingClientRect();
    await pie.hover({ position: { x: pieBounds.width * 0.55, y: pieBounds.height * 0.15 } });
    await expect
      .poll(() => cpuDonut.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
      .toContain("Core bigbud");
    expect(cpuDonut.element().querySelector(".recharts-tooltip-wrapper")?.textContent).toContain(
      "4.80%",
    );
    await screen.unmount();
  },
);

it.each([false, true])(
  "keeps empty-history cards aligned by default (large: %s)",
  async (large) => {
    vi.mocked(useResourceMonitor).mockReturnValue({
      snapshot: appMonitorSnapshot(),
      history: { cpu: [], memory: [], network: [] },
      appHistory: EMPTY_APP_HISTORY,
      appReason: null,
      connection: "connected",
      reason: null,
      collectionStatus: null,
    });
    const screen = await render(
      <div style={{ width: 896 }}>
        <BigbudResourceView visible large={large} />
      </div>,
    );
    const ioCard = screen
      .getByText("Disk I/O", { exact: true })
      .element()
      .closest('[data-slot="card"]')!;
    const inclusiveCard = screen
      .getByRole("heading", { name: "Including agents/tools" })
      .element()
      .closest('[data-slot="card"]')!;
    const ioBounds = ioCard.getBoundingClientRect();
    const inclusiveBounds = inclusiveCard.getBoundingClientRect();
    expect(ioBounds.height).toBe(inclusiveBounds.height);
    expect(ioBounds.height).toBeGreaterThanOrEqual(large ? 288 : 240);
    expect(ioBounds.top).toBe(inclusiveBounds.top);
    expect(screen.getByText("Waiting for history…").elements()).toHaveLength(4);
    await screen.unmount();
  },
);
