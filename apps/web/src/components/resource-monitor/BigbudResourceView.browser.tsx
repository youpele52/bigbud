import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { BigbudResourceView } from "./BigbudResourceView";
import { MonitorScopeToggle } from "./MonitorScopeToggle";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import { useResourceMonitor } from "./useResourceMonitor";

vi.mock("./useResourceMonitor", () => ({ useResourceMonitor: vi.fn() }));
afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 340, large: false },
  { width: 896, large: true },
])(
  "shows core/inclusive usage and histories without overflowing a $width px surface",
  async ({ width, large }) => {
    await page.viewport(1100, 2000);
    document.documentElement.classList.add("dark");
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
      },
      appReason: null,
      connection: "connected",
      reason: null,
      collectionStatus: null,
    });
    const screen = await render(
      <div
        className="dark space-y-3 bg-background p-4 text-foreground"
        style={{ width }}
        data-testid="monitor-surface"
      >
        <MonitorScopeToggle scope="bigbud" onScopeChange={() => undefined} />
        <BigbudResourceView visible large={large} />
      </div>,
    );
    await expect.element(screen.getByRole("img", { name: "CPU history" })).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "Memory history" })).toBeVisible();
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
      .getByRole("img", { name: "CPU history" })
      .element()
      .getBoundingClientRect();
    expect(historyRect.top).toBeGreaterThanOrEqual(donutRect.bottom);
    await expect
      .element(screen.getByRole("heading", { name: "Including agents/tools" }))
      .toBeVisible();
    const surface = screen.getByTestId("monitor-surface");
    expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
    const screenshotDirectory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
    if (screenshotDirectory)
      await surface.screenshot({ path: `${screenshotDirectory}/bigbud-monitor-${width}.png` });
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
