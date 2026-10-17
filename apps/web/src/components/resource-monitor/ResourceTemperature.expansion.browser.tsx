import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ResourceTemperatures } from "./ResourceTemperatures";
import { temperatureHistoryKey } from "~/stores/resource-monitor/resourceMonitor.temperatureHistory";
import {
  sensorHistories,
  sensorMetric,
  temperatureSnapshot,
} from "./ResourceTemperatures.fixtures";

it.each([1200, 340])("zooms live temperature and reported threshold at %s px", async (width) => {
  await page.viewport(width, 900);
  const snapshot = temperatureSnapshot();
  const screen = await render(
    <ResourceTemperatures
      snapshot={snapshot}
      history={sensorHistories()}
      current
      loading={false}
    />,
  );
  try {
    const trigger = screen.getByRole("button", {
      name: "Expand gas gauge battery temperature sensor",
      exact: true,
    });
    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    const dialog = page.getByRole("dialog", {
      name: "gas gauge battery temperature sensor",
      exact: true,
    });
    await expect.element(dialog).toBeVisible();
    await userEvent.keyboard("{Tab}");
    expect(dialog.element().contains(document.activeElement)).toBe(true);
    await expect.element(dialog.getByText("45.00 °C", { exact: true })).toBeVisible();
    const chart = dialog.getByRole("img", {
      name: "gas gauge battery temperature history",
      exact: true,
    });
    await expect.element(chart).toBeVisible();
    await expect.poll(() => chart.element().getBoundingClientRect().height).toBe(256);
    expect(chart.element().querySelector(".recharts-yAxis")).not.toBeNull();
    const originalPath = chart.element().querySelector(".recharts-area-curve")!.getAttribute("d");
    const sensor = { name: "gas gauge battery", metric: sensorMetric(46, "ready", 2000) };
    const next = {
      ...snapshot,
      temperaturesCelsius: snapshot.temperaturesCelsius.map((item) =>
        item.name === sensor.name ? sensor : item,
      ),
    };
    const history = {
      ...sensorHistories(),
      [temperatureHistoryKey(sensor)]: [
        { sequence: 31, value: 44 },
        { sequence: 32, value: 46 },
      ],
    };
    await screen.rerender(
      <ResourceTemperatures snapshot={next} history={history} current loading={false} />,
    );
    const reading = dialog.getByLabelText("46.00 °C, critical threshold reached", { exact: true });
    await expect.element(reading).toBeVisible();
    await expect
      .element(dialog.getByText("Reported critical threshold reached", { exact: true }))
      .toBeVisible();
    expect(reading.element().classList.contains("text-destructive")).toBe(true);
    expect(chart.element().querySelector(".recharts-area-curve")!.getAttribute("stroke")).toBe(
      "var(--chart-1)",
    );
    expect(chart.element().querySelector(".recharts-area-area")!.getAttribute("fill")).toBe(
      "var(--chart-1)",
    );
    expect(chart.element().querySelector(".recharts-area-area")!.getAttribute("fill-opacity")).toBe(
      "0.12",
    );
    await expect
      .poll(() => chart.element().querySelector(".recharts-area-curve")!.getAttribute("d"))
      .not.toBe(originalPath);
    expect(dialog.element().scrollWidth).toBeLessThanOrEqual(width);
    const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
    if (directory)
      await dialog.screenshot({ path: `${directory}/temperature-expanded-${width}.png` });
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await trigger.click();
    await expect.element(dialog).toBeVisible();
    await expect.poll(() => chart.element().getBoundingClientRect().height).toBe(256);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

it("handles signed readings, unknown thresholds, disconnection and sensor removal in an open view", async () => {
  await page.viewport(1200, 900);
  const sensor = { name: "cold", metric: sensorMetric(-10) };
  const snapshot = {
    ...temperatureSnapshot(),
    temperaturesCelsius: [sensor],
    criticalTemperaturesCelsius: [],
  };
  const history = {
    [temperatureHistoryKey(sensor)]: [
      { sequence: 1, value: -11 },
      { sequence: 2, value: -10 },
    ],
  };
  const screen = await render(
    <ResourceTemperatures snapshot={snapshot} history={history} current loading={false} />,
  );
  try {
    await screen
      .getByRole("button", { name: "Expand cold temperature sensor", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "cold temperature sensor", exact: true });
    await expect.element(dialog.getByLabelText("-10.00 °C", { exact: true })).toBeVisible();
    await expect.element(dialog.getByText("Unavailable", { exact: true })).toBeVisible();
    const chart = dialog.getByRole("img", { name: "cold temperature history", exact: true });
    await expect.element(chart).toBeVisible();
    expect(chart.element().querySelector(".recharts-area-curve")!.getAttribute("d")).not.toContain(
      "NaN",
    );
    const application = chart.getByRole("application");
    const bounds = application.element().getBoundingClientRect();
    await application.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
    await expect
      .poll(() => chart.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
      .toContain("-10.00 °C");
    await screen.rerender(
      <ResourceTemperatures
        snapshot={snapshot}
        history={history}
        current={false}
        loading={false}
      />,
    );
    expect(dialog.getByRole("img").elements()).toHaveLength(0);
    expect(dialog.element().querySelector(".text-destructive")).toBeNull();
    expect(dialog.element().querySelector('[data-loading="true"]')).toBeNull();
    await screen.rerender(
      <ResourceTemperatures
        snapshot={{ ...snapshot, temperaturesCelsius: [] }}
        history={{}}
        current
        loading={false}
      />,
    );
    await expect.element(dialog).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
