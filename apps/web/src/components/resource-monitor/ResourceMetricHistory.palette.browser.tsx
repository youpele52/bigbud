import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ResourceMetricHistory } from "./ResourceMetricHistory";
import { ResourceTemperatures } from "./ResourceTemperatures";
import { sensorHistories, temperatureSnapshot } from "./ResourceTemperatures.fixtures";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([false, true])(
  "shares CPU/Memory chart green with compact and expanded temperatures (dark: %s)",
  async (dark) => {
    document.documentElement.classList.toggle("dark", dark);
    await page.viewport(1200, 900);
    const history = [
      { sequence: 1, value: 40 },
      { sequence: 2, value: 45 },
    ];
    const screen = await render(
      <div style={{ width: 800 }}>
        <ResourceMetricHistory metric={{ label: "CPU", value: "", status: "ready", history }} />
        <ResourceMetricHistory metric={{ label: "Memory", value: "", status: "ready", history }} />
        <ResourceTemperatures
          snapshot={temperatureSnapshot()}
          history={sensorHistories()}
          current
          loading={false}
        />
      </div>,
    );
    try {
      const cpu = screen.getByRole("img", {
        name: "CPU history",
        exact: true,
        includeHidden: true,
      });
      await expect.poll(() => cpu.element().querySelector(".recharts-area-curve")).not.toBeNull();
      await screen
        .getByRole("button", { name: "Expand gas gauge battery temperature sensor", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "gas gauge battery temperature sensor",
        exact: true,
      });
      await expect.element(dialog).toBeVisible();
      const charts = [
        screen.getByRole("img", { name: "Memory history", exact: true, includeHidden: true }),
        screen
          .getByRole("region", {
            name: "gas gauge battery temperature sensor",
            exact: true,
            includeHidden: true,
          })
          .getByRole("img", {
            name: "gas gauge battery temperature history",
            exact: true,
            includeHidden: true,
          }),
        dialog.getByRole("img", { name: "gas gauge battery temperature history", exact: true }),
      ];
      const cpuCurve = cpu.element().querySelector(".recharts-area-curve")!;
      const cpuArea = cpu.element().querySelector(".recharts-area-area")!;
      for (const chart of charts) {
        await expect
          .poll(() => chart.element().querySelector(".recharts-area-area"))
          .not.toBeNull();
        const curve = chart.element().querySelector(".recharts-area-curve")!;
        const area = chart.element().querySelector(".recharts-area-area")!;
        expect(curve.getAttribute("stroke")).toBe("var(--chart-1)");
        expect(area.getAttribute("fill")).toBe("var(--chart-1)");
        expect(area.getAttribute("fill-opacity")).toBe("0.12");
        expect(getComputedStyle(curve).stroke).toBe(getComputedStyle(cpuCurve).stroke);
        expect(getComputedStyle(area).fill).toBe(getComputedStyle(cpuArea).fill);
      }
      await expect
        .element(screen.getByText(/Chart colors do not indicate safety/))
        .toBeInTheDocument();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
    } finally {
      await screen.unmount();
    }
  },
);
