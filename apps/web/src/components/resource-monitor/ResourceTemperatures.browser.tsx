import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ResourceTemperatures } from "./ResourceTemperatures";
import {
  sensorHistories,
  sensorMetric,
  temperatureSnapshot,
} from "./ResourceTemperatures.fixtures";
import { expectCenteredStatuses } from "../common/CenteredStatus.browser.utils";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 896, dark: true },
  { width: 896, dark: false },
  { width: 340, dark: true },
])("uses compact neutral sensor tiles at $width px (dark: $dark)", async ({ width, dark }) => {
  await page.viewport(1200, 1300);
  document.documentElement.classList.toggle("dark", dark);
  const snapshot = temperatureSnapshot();
  const screen = await render(
    <div className="bg-background p-4 text-foreground" style={{ width }} data-testid="surface">
      <ResourceTemperatures
        snapshot={snapshot}
        history={sensorHistories()}
        current
        loading={false}
      />
    </div>,
  );
  try {
    const section = screen.getByRole("region", { name: "Temperatures", exact: true });
    const tiles = section.element().querySelectorAll('section[role="region"]');
    expect(tiles).toHaveLength(6);
    expect(Array.from(tiles, (tile) => tile.getAttribute("aria-label"))).toEqual([
      "gas gauge battery temperature sensor",
      "PMU tdev3 temperature sensor",
      "PMU tdev8 temperature sensor",
      "PMU tdie10 temperature sensor",
      "PMU TP2g temperature sensor",
      "PMU TP3g temperature sensor",
    ]);
    const first = tiles[0]!.getBoundingClientRect();
    const second = tiles[1]!.getBoundingClientRect();
    if (width > 640) {
      expect(first.top).toBe(second.top);
      expect(first.width).toBeCloseTo(second.width);
      expect(second.left).toBeGreaterThan(first.right);
    } else {
      expect(second.top).toBeGreaterThan(first.bottom);
      expect(first.left).toBe(second.left);
    }
    await expect.element(section.getByText("Hottest: 62.81 °C", { exact: true })).toBeVisible();
    const sensor = section.getByRole("region", {
      name: "PMU TP2g temperature sensor",
      exact: true,
    });
    await expect.element(sensor.getByText("61.64 °C", { exact: true })).toBeVisible();
    const chart = sensor.getByRole("img", { name: "PMU TP2g temperature history", exact: true });
    await expect.element(chart).toBeVisible();
    expect(chart.element().getBoundingClientRect().height).toBe(48);
    const application = chart.getByRole("application");
    const bounds = application.element().getBoundingClientRect();
    await application.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
    await expect
      .poll(() => chart.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
      .toContain("°C");
    await sensor.getByRole("heading", { name: "PMU TP2g", exact: true }).hover();
    expect(section.element().querySelector(".text-destructive")).toBeNull();
    expect(section.getByText("Critical: unavailable", { exact: true }).elements()).toHaveLength(0);
    expect(
      section.getByText(/Some sensors do not report critical thresholds/).elements(),
    ).toHaveLength(1);
    const surface = screen.getByTestId("surface");
    expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
    const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
    if (directory)
      await surface.screenshot({
        path: `${directory}/temperatures-${width}-${dark ? "dark" : "light"}.png`,
      });
  } finally {
    await screen.unmount();
  }
});

it("keeps sensor order and tile identities stable instead of sorting by live heat", async () => {
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
    const sensor = screen.getByRole("region", { name: "PMU TP2g temperature sensor", exact: true });
    const original = sensor.element();
    const names = screen
      .getByRole("heading", { level: 3 })
      .elements()
      .map((heading) => heading.textContent);
    const next = {
      ...snapshot,
      temperaturesCelsius: snapshot.temperaturesCelsius.toReversed().map((sensor) =>
        Object.assign({}, sensor, {
          metric: sensorMetric(sensor.name === "PMU TP2g" ? 110 : sensor.metric.value),
        }),
      ),
    };
    await screen.rerender(
      <ResourceTemperatures
        snapshot={next}
        history={sensorHistories(next)}
        current
        loading={false}
      />,
    );
    expect(sensor.element()).toBe(original);
    expect(
      screen
        .getByRole("heading", { level: 3 })
        .elements()
        .map((heading) => heading.textContent),
    ).toEqual(names);
    await expect.element(screen.getByText("Hottest: 110.00 °C", { exact: true })).toBeVisible();
    expect(sensor.element().querySelector(".text-destructive")).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it("centers loading and empty states, and hides retained histories after disconnection", async () => {
  const screen = await render(
    <div style={{ width: 340 }} data-testid="surface">
      <ResourceTemperatures snapshot={null} history={{}} current={false} loading />
    </div>,
  );
  try {
    const surface = screen.getByTestId("surface").element();
    expectCenteredStatuses(surface);
    await expect
      .element(screen.getByText("Waiting for temperature sensors", { exact: true }))
      .toBeVisible();
    await screen.rerender(
      <div style={{ width: 340 }} data-testid="surface">
        <ResourceTemperatures
          snapshot={temperatureSnapshot()}
          history={sensorHistories()}
          current={false}
          loading={false}
        />
      </div>,
    );
    expect(screen.getByRole("img", { name: /temperature history/ }).elements()).toHaveLength(0);
    await expect.element(screen.getByText("Hottest: —", { exact: true })).toBeVisible();
    expect(surface.querySelector('[data-loading="true"]')).toBeNull();
    expectCenteredStatuses(surface);
  } finally {
    await screen.unmount();
  }
});
