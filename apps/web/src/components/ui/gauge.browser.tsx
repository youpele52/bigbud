import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { Gauge } from "./gauge";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([false, true])(
  "renders readable usage bands and updates the needle (dark: %s)",
  async (dark) => {
    document.documentElement.classList.toggle("dark", dark);
    const screen = await render(
      <div
        style={{ width: 240 }}
        className="bg-background p-2 text-foreground"
        data-testid="surface"
      >
        <Gauge value={2.98} label="CPU usage" description="of total host CPU" />
      </div>,
    );
    const meter = screen.getByRole("meter", { name: "CPU usage" });
    await expect.element(meter).toBeVisible();
    await expect.element(meter).toHaveAttribute("aria-valuenow", "2.98");
    const needle = meter.element().querySelector('[data-slot="gauge-needle"]')!;
    expect(needle.getAttribute("style")).toContain("rotate(5.364deg)");
    expect(meter.element().querySelectorAll('[data-active="true"]')).toHaveLength(2);
    await screen.rerender(
      <div
        style={{ width: 240 }}
        className="bg-background p-2 text-foreground"
        data-testid="surface"
      >
        <Gauge value={92} label="CPU usage" description="of total host CPU" />
      </div>,
    );
    await expect.element(meter).toHaveAttribute("aria-valuenow", "92");
    expect(meter.element().querySelector('[data-slot="gauge-needle"]')).toBe(needle);
    expect(needle.getAttribute("style")).toContain("rotate(165.6deg)");
    expect(meter.element().querySelectorAll('[data-active="true"]')).toHaveLength(36);
    const readout = meter.element().querySelector('[data-slot="gauge-value"]')!;
    const active = meter.element().querySelectorAll('[data-active="true"]');
    expect(getComputedStyle(readout).color).toBe(
      getComputedStyle(active[active.length - 1]!).stroke,
    );
    const surface = screen.getByTestId("surface").element();
    expect(surface.scrollWidth).toBeLessThanOrEqual(240);
    await screen.unmount();
  },
);
