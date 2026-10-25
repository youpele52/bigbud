import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ResourceCpuCores } from "./ResourceCpuCores";
import { cpuCoreReadings } from "./ResourceCpuCores.fixtures";
import { expectCenteredStatuses } from "../common/CenteredStatus.browser.utils";
import { usagePercentColor } from "../ui/usageBands.logic";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 340, dark: false },
  { width: 340, dark: true },
  { width: 896, dark: true },
])(
  "shows equal-scale usage-colored bars without overflow at $width px (dark: $dark)",
  async ({ width, dark }) => {
    await page.viewport(1200, 1000);
    document.documentElement.classList.toggle("dark", dark);
    let readings = cpuCoreReadings();
    const content = () => (
      <div className="bg-background p-4 text-foreground" style={{ width }} data-testid="surface">
        <ResourceCpuCores cores={readings} active loading={false} />
      </div>
    );
    const screen = await render(content());
    try {
      const region = screen.getByRole("region", { name: "CPU cores" });
      const grid = region.element().querySelector('[data-slot="cpu-core-grid"]')!;
      expect(getComputedStyle(grid).gridTemplateColumns.split(" ")).toHaveLength(
        width < 640 ? 1 : 2,
      );
      const meters = region.getByRole("meter").elements();
      expect(meters).toHaveLength(10);
      expect(
        region
          .getByRole("group")
          .elements()
          .map((row) => row.getAttribute("aria-label")),
      ).toEqual(readings.map(({ name }) => `Core ${name}`));
      for (let index = 0; index < meters.length; index++) {
        const meter = meters[index]!;
        expect(meter.getAttribute("aria-valuemax")).toBe("100");
        expect(meter.getAttribute("aria-valuenow")).toBe(String(readings[index]!.metric.value));
        expect(meter.getBoundingClientRect().width).toBeCloseTo(
          meters[0]!.getBoundingClientRect().width,
        );
        expect(meter.querySelector('[data-slot="cpu-core-fill"]')?.getAttribute("style")).toContain(
          `width: ${readings[index]!.metric.value}%`,
        );
        expect(
          (meter.querySelector('[data-slot="cpu-core-fill"]') as HTMLElement).style.backgroundColor,
        ).toBe(usagePercentColor(readings[index]!.metric.value));
      }
      const surface = screen.getByTestId("surface");
      expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
      const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
      if (directory)
        await surface.screenshot({
          path: `${directory}/cpu-cores-${width}-${dark ? "dark" : "light"}.png`,
        });
      const first = meters[0]!;
      readings = readings.with(0, {
        ...readings[0]!,
        metric: { ...readings[0]!.metric, value: 20 },
      });
      await screen.rerender(content());
      expect(region.getByRole("meter", { name: "Core 0 usage", exact: true }).element()).toBe(
        first,
      );
      await expect
        .element(region.getByRole("meter", { name: "Core 0 usage", exact: true }))
        .toHaveAttribute("aria-valuenow", "20");
      expect(
        (first.querySelector('[data-slot="cpu-core-fill"]') as HTMLElement).style.backgroundColor,
      ).toBe("var(--chart-1)");
      for (const [value, color, status] of [
        [49.999, "var(--chart-1)", "Normal usage"],
        [50, "var(--chart-3)", "High usage"],
        [79.999, "var(--chart-3)", "High usage"],
        [80, "var(--chart-4)", "Critical usage"],
      ] as const) {
        readings = readings.with(0, { ...readings[0]!, metric: { ...readings[0]!.metric, value } });
        await screen.rerender(content());
        await expect
          .element(region.getByRole("meter", { name: "Core 0 usage", exact: true }))
          .toHaveAttribute("aria-valuetext", `${value.toFixed(2)}% · ${status}`);
        expect(
          (first.querySelector('[data-slot="cpu-core-fill"]') as HTMLElement).style.backgroundColor,
        ).toBe(color);
      }
    } finally {
      await screen.unmount();
    }
  },
);

it("distinguishes measured zero from stale values and centers initial loading", async () => {
  const readings = cpuCoreReadings();
  readings[0]!.metric.value = 0;
  readings[1]!.metric.status = "stale";
  const screen = await render(<ResourceCpuCores cores={readings} active loading={false} />);
  try {
    await expect
      .element(screen.getByRole("meter", { name: "Core 0 usage", exact: true }))
      .toHaveAttribute("aria-valuenow", "0");
    await expect.element(screen.getByRole("img", { name: "Core 1 usage stale" })).toBeVisible();
    expect(
      screen
        .getByRole("img", { name: "Core 1 usage stale" })
        .element()
        .querySelector('[data-slot="cpu-core-fill"]'),
    ).toBeNull();
    await screen.rerender(<ResourceCpuCores cores={[]} active={false} loading />);
    expectCenteredStatuses(screen.getByRole("region", { name: "CPU cores" }).element());
    await screen.rerender(<ResourceCpuCores cores={readings} active={false} loading={false} />);
    expect(screen.getByRole("meter").elements()).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});
