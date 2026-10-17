import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ResourceMemorySwap } from "./ResourceMemorySwap";
import { ResourceMetricCard } from "./ResourceMetricCard";
import { memorySwapMetric, memorySwapSnapshot } from "./ResourceMemorySwap.fixtures";
import { expectCenteredStatuses } from "../common/CenteredStatus.browser.utils";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 896, dark: true },
  { width: 896, dark: false },
  { width: 340, dark: true },
])(
  "shares the Disk capacity-bar design without overflow at $width px (dark: $dark)",
  async ({ width, dark }) => {
    await page.viewport(1200, 1000);
    document.documentElement.classList.toggle("dark", dark);
    const screen = await render(
      <div
        className="@container bg-background p-4 text-foreground"
        style={{ width }}
        data-testid="surface"
      >
        <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
          <ResourceMetricCard
            metric={{
              label: "Disk",
              value: "",
              status: "ready",
              capacityUsage: {
                usedBytes: 446.34 * 1024 ** 3,
                totalBytes: 460.43 * 1024 ** 3,
                footer: ["Free: 14.10 GiB", "Macintosh HD (/)"],
              },
            }}
            large
          />
          <ResourceMemorySwap snapshot={memorySwapSnapshot()} current loading={false} />
        </div>
      </div>,
    );
    try {
      const memory = screen.getByRole("region", { name: "Memory and swap", exact: true });
      const ram = memory.getByRole("meter", { name: "RAM capacity used", exact: true });
      const swap = memory.getByRole("meter", { name: "Swap capacity used", exact: true });
      const disk = screen.getByRole("meter", { name: "Disk capacity used", exact: true });
      for (const bar of [disk, ram, swap]) {
        await expect.element(bar).toBeVisible();
        expect(bar.element().getBoundingClientRect().height).toBe(8);
        expect(bar.element().className).toBe(disk.element().className);
      }
      await expect.element(memory.getByText("83.09%", { exact: false })).toBeVisible();
      await expect.element(memory.getByText("72.75%", { exact: false })).toBeVisible();
      await expect
        .element(memory.getByText("53.18 GiB / 64.00 GiB", { exact: true }))
        .toBeVisible();
      await expect.element(memory.getByText("2.91 GiB / 4.00 GiB", { exact: true })).toBeVisible();
      await expect.element(memory.getByText("Available: 28.14 GiB", { exact: true })).toBeVisible();
      await expect.element(memory.getByText("Free: 1.09 GiB", { exact: true })).toBeVisible();
      expect((ram.element().firstElementChild as HTMLElement).style.backgroundColor).toBe(
        "var(--chart-4)",
      );
      expect((swap.element().firstElementChild as HTMLElement).style.backgroundColor).toBe(
        "var(--chart-3)",
      );
      expect(memory.element().querySelector('[data-slot="gauge"]')).toBeNull();
      expect(ram.element().getBoundingClientRect().top).toBeLessThan(
        swap.element().getBoundingClientRect().top,
      );
      const surface = screen.getByTestId("surface");
      expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
      const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
      if (directory)
        await surface.screenshot({
          path: `${directory}/memory-swap-${width}-${dark ? "dark" : "light"}.png`,
        });
    } finally {
      await screen.unmount();
    }
  },
);

it("updates both pools and distinguishes no allocated swap from zero usage", async () => {
  const snapshot = memorySwapSnapshot();
  const screen = await render(<ResourceMemorySwap snapshot={snapshot} current loading={false} />);
  try {
    await screen.rerender(
      <ResourceMemorySwap
        snapshot={{
          ...snapshot,
          memoryUsedBytes: memorySwapMetric(62),
          swapUsedBytes: memorySwapMetric(0),
        }}
        current
        loading={false}
      />,
    );
    const ram = screen.getByRole("meter", { name: "RAM capacity used", exact: true });
    await expect.element(ram).toHaveAttribute("aria-valuenow", "96.875");
    expect((ram.element().firstElementChild as HTMLElement).style.backgroundColor).toBe(
      "var(--chart-4)",
    );
    await expect
      .element(screen.getByRole("meter", { name: "Swap capacity used", exact: true }))
      .toHaveAttribute("aria-valuenow", "0");
    await screen.rerender(
      <ResourceMemorySwap
        snapshot={{
          ...snapshot,
          swapUsedBytes: memorySwapMetric(0),
          swapTotalBytes: memorySwapMetric(0),
          swapFreeBytes: memorySwapMetric(0),
        }}
        current
        loading={false}
      />,
    );
    await expect.element(screen.getByText("No swap allocated", { exact: true })).toBeVisible();
    expect(
      screen.getByRole("meter", { name: "Swap capacity used", exact: true }).elements(),
    ).toHaveLength(0);
    await expect.element(screen.getByText("0.00 GiB / 0.00 GiB", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("bounds only the drawn RAM bar when the measured estimate exceeds total memory", async () => {
  const screen = await render(
    <ResourceMemorySwap
      snapshot={{ ...memorySwapSnapshot(), memoryUsedBytes: memorySwapMetric(80) }}
      current
      loading={false}
    />,
  );
  try {
    const ram = screen.getByRole("meter", { name: "RAM capacity used", exact: true });
    await expect.element(ram).toHaveAttribute("aria-valuenow", "100");
    await expect
      .element(ram)
      .toHaveAttribute("aria-valuetext", "125.00% used · Usage exceeds capacity");
    expect(ram.element().firstElementChild!.getBoundingClientRect().width).toBe(
      ram.element().getBoundingClientRect().width,
    );
    await expect.element(screen.getByText("125.00%", { exact: false })).toBeVisible();
    await expect.element(screen.getByText("80.00 GiB / 64.00 GiB", { exact: true })).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("centers pending states and does not animate or retain readouts after disconnection", async () => {
  const screen = await render(
    <div style={{ width: 340 }} data-testid="surface">
      <ResourceMemorySwap snapshot={null} current={false} loading />
    </div>,
  );
  try {
    const surface = screen.getByTestId("surface").element();
    expectCenteredStatuses(surface);
    expect(surface.querySelectorAll('[data-loading="true"]')).toHaveLength(2);
    await screen.rerender(
      <div style={{ width: 340 }} data-testid="surface">
        <ResourceMemorySwap snapshot={memorySwapSnapshot()} current={false} loading={false} />
      </div>,
    );
    expectCenteredStatuses(surface);
    expect(surface.querySelectorAll('[data-loading="true"]')).toHaveLength(0);
    expect(screen.getByRole("meter").elements()).toHaveLength(0);
    expect(screen.getByText("53.18 GiB / 64.00 GiB", { exact: true }).elements()).toHaveLength(0);
  } finally {
    await screen.unmount();
  }
});
