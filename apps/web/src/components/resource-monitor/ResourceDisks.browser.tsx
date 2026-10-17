import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ResourceDisks } from "./ResourceDisks";
import { diskMonitorHistory, diskMonitorSnapshot } from "./ResourceDisks.fixtures";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 896, dark: false },
  { width: 896, dark: true },
  { width: 340, dark: true },
])(
  "uses full-width capacity rows and mini mirrored graphs at $width px (dark: $dark)",
  async ({ width, dark }) => {
    await page.viewport(1200, 1000);
    document.documentElement.classList.toggle("dark", dark);
    const screen = await render(
      <div className="bg-background p-4 text-foreground" style={{ width }} data-testid="surface">
        <div className="grid grid-cols-2 gap-3">
          <ResourceDisks
            snapshot={diskMonitorSnapshot()}
            history={diskMonitorHistory()}
            active
            loading={false}
          />
          <div data-testid="half-card">Other details</div>
        </div>
      </div>,
    );
    try {
      const disks = screen.getByRole("region", { name: "Disks", exact: true });
      const row = screen.getByRole("region", { name: "Macintosh HD (/) disk", exact: true });
      const meter = row.getByRole("meter");
      await expect.element(meter).toBeVisible();
      await expect.element(meter).toHaveAttribute("aria-valuenow", "96.875");
      const rates = row.getByRole("group", { name: "I/O transfer rates" });
      const history = row.getByRole("img", { name: "Macintosh HD (/) I/O history" });
      await expect.element(history).toBeVisible();
      const readings = row.element().querySelector('[data-slot="disk-io-readings"]')!;
      const graphBounds = history.element().getBoundingClientRect();
      const readingBounds = readings.getBoundingClientRect();
      expect(graphBounds.height).toBeCloseTo(readingBounds.height);
      expect(graphBounds.height).toBeGreaterThan(48);
      expect(graphBounds.top).toBeCloseTo(readingBounds.bottom);
      const ioPanel = row.element().querySelector('[data-slot="disk-io-panel"]')!;
      expect(graphBounds.bottom).toBeCloseTo(ioPanel.getBoundingClientRect().bottom);
      expect(disks.element().getBoundingClientRect().width).toBeGreaterThan(
        screen.getByTestId("half-card").element().getBoundingClientRect().width * 1.8,
      );
      expect(getComputedStyle(rates.element().querySelector("dd")!).fontSize).toBe("12px");
      const arrows = rates.element().querySelectorAll("svg");
      const lines = history.element().querySelectorAll(".recharts-area-curve");
      expect(lines).toHaveLength(2);
      for (let index = 0; index < 2; index++)
        expect(getComputedStyle(arrows[index]!).color).toBe(getComputedStyle(lines[index]!).stroke);
      if (width === 896) {
        expect(rates.element().getBoundingClientRect().left).toBeGreaterThan(
          meter.element().getBoundingClientRect().right,
        );
        expect(meter.element().getBoundingClientRect().width).toBeGreaterThan(
          rates.element().getBoundingClientRect().width,
        );
      } else
        expect(rates.element().getBoundingClientRect().top).toBeGreaterThan(
          meter.element().getBoundingClientRect().bottom,
        );
      const application = history.getByRole("application");
      const bounds = application.element().getBoundingClientRect();
      await application.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
      await expect
        .poll(() => history.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
        .toContain("Read");
      await expect
        .poll(() => history.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
        .toContain("Write");
      expect(history.element().querySelector(".recharts-tooltip-wrapper")?.textContent).not.toMatch(
        /-\d/,
      );
      expect(screen.getByTestId("surface").element().scrollWidth).toBeLessThanOrEqual(width);
      const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
      if (directory)
        await screen
          .getByTestId("surface")
          .screenshot({ path: `${directory}/disks-${width}-${dark ? "dark" : "light"}.png` });
    } finally {
      await screen.unmount();
    }
  },
);

it("keeps unsupported I/O static and clears graphs when inactive", async () => {
  const snapshot = diskMonitorSnapshot();
  const screen = await render(
    <ResourceDisks snapshot={snapshot} history={diskMonitorHistory()} active loading={false} />,
  );
  try {
    expect(screen.getByRole("img", { name: /I\/O history/ }).elements()).toHaveLength(2);
    await screen.rerender(
      <ResourceDisks
        snapshot={snapshot}
        history={diskMonitorHistory()}
        active={false}
        loading={false}
      />,
    );
    expect(screen.getByRole("img", { name: /I\/O history/ }).elements()).toHaveLength(0);
    expect(screen.getByText("Disk I/O unavailable", { exact: true }).elements()).toHaveLength(2);
    expect(document.querySelector(".animate-breathe")).toBeNull();
  } finally {
    await screen.unmount();
  }
});
