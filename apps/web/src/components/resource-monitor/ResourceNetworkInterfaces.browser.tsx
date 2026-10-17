import "../../index.css";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ResourceNetworkInterfaces } from "./ResourceNetworkInterfaces";
import {
  interfaceMonitorHistory,
  monitorInterfaces,
  interfaceMetric,
} from "./ResourceNetworkInterfaces.fixtures";

afterEach(() => document.documentElement.classList.remove("dark"));

it.each([
  { width: 896, dark: false },
  { width: 896, dark: true },
  { width: 640, dark: false },
  { width: 340, dark: true },
])(
  "renders full-width sections and responsive interface pairs at $width px (dark: $dark)",
  async ({ width, dark }) => {
    await page.viewport(1200, 1800);
    document.documentElement.classList.toggle("dark", dark);
    const screen = await render(
      <div className="bg-background p-4 text-foreground" style={{ width }} data-testid="surface">
        <div className="grid grid-cols-2 gap-3">
          <ResourceNetworkInterfaces
            interfaces={monitorInterfaces()}
            history={interfaceMonitorHistory()}
          />
          <div data-testid="half-card">Other details</div>
        </div>
      </div>,
    );
    try {
      const section = screen.getByRole("region", { name: "Network interfaces", exact: true });
      expect(section.element().getBoundingClientRect().width).toBeGreaterThan(
        screen.getByTestId("half-card").element().getBoundingClientRect().width * 1.8,
      );
      const cards = section.element().querySelectorAll('section[role="region"]');
      expect(Array.from(cards, (card) => card.getAttribute("aria-label"))).toEqual([
        "awdl0 network interface",
        "bridge0 network interface",
        "en0 network interface",
      ]);
      expect(cards[0]!.getBoundingClientRect().height).toBeCloseTo(
        cards[1]!.getBoundingClientRect().height,
      );
      expect(cards[1]!.getBoundingClientRect().height).toBeCloseTo(
        cards[2]!.getBoundingClientRect().height,
      );
      const first = cards[0]!.getBoundingClientRect();
      const second = cards[1]!.getBoundingClientRect();
      const third = cards[2]!.getBoundingClientRect();
      if (width === 896) {
        expect(first.top).toBe(second.top);
        expect(second.left).toBeGreaterThan(first.right);
        expect(third.left).toBe(first.left);
        expect(third.top).toBeGreaterThan(first.bottom);
      } else {
        expect(first.left).toBe(second.left);
        expect(second.top).toBeGreaterThan(first.bottom);
        expect(third.top).toBeGreaterThan(second.bottom);
      }
      const en0 = section.getByRole("region", { name: "en0 network interface", exact: true });
      await expect.element(en0.getByText("1.40 MiB/s", { exact: true })).toBeVisible();
      await expect.element(en0.getByText("1.39 MiB/s", { exact: true })).toBeVisible();
      await expect.element(en0.getByRole("img", { name: "Link up", exact: true })).toBeVisible();
      const up = en0.getByRole("img", { name: "Link up", exact: true });
      await expect.element(up).toHaveAttribute("title", "Link up");
      expect(up.element().classList.contains("bg-success")).toBe(true);
      expect(getComputedStyle(up.element()).animationName).toBe("none");
      expect(up.element().getBoundingClientRect().width).toBe(8);
      const down = section
        .getByRole("region", { name: "awdl0 network interface", exact: true })
        .getByRole("img", { name: "Link down", exact: true });
      await expect.element(down).toBeVisible();
      expect(down.element().classList.contains("bg-destructive")).toBe(true);
      expect(getComputedStyle(down.element()).animationName).toBe("none");
      expect(section.getByText("Link up", { exact: true }).elements()).toHaveLength(0);
      expect(section.getByText("Link down", { exact: true }).elements()).toHaveLength(0);
      await expect.element(en0.getByText("79.90 GiB", { exact: true })).toBeVisible();
      await expect.element(en0.getByText("MTU", { exact: true })).not.toBeVisible();
      const history = en0.getByRole("img", { name: "en0 network history", exact: true });
      await expect.element(history).toBeVisible();
      expect(history.element().getBoundingClientRect().height).toBe(80);
      const arrows = en0
        .getByRole("group", { name: "Network transfer rates" })
        .element()
        .querySelectorAll("svg");
      const lines = history.element().querySelectorAll(".recharts-area-curve");
      expect(lines).toHaveLength(2);
      for (let index = 0; index < 2; index++)
        expect(getComputedStyle(arrows[index]!).color).toBe(getComputedStyle(lines[index]!).stroke);
      const application = history.getByRole("application");
      const bounds = application.element().getBoundingClientRect();
      await application.hover({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
      await expect
        .poll(() => history.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
        .toContain("Download");
      await expect
        .poll(() => history.element().querySelector(".recharts-tooltip-wrapper")?.textContent)
        .toContain("Upload");
      expect(history.element().querySelector(".recharts-tooltip-wrapper")?.textContent).not.toMatch(
        /-\d/,
      );
      await en0.getByRole("heading", { name: "en0", exact: true }).hover();
      const surface = screen.getByTestId("surface");
      expect(surface.element().scrollWidth).toBeLessThanOrEqual(width);
      const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
      if (directory)
        await surface.screenshot({
          path: `${directory}/interfaces-${width}-${dark ? "dark" : "light"}.png`,
        });
    } finally {
      await screen.unmount();
    }
  },
);

it("keeps cards, heights and expanded details stable when traffic or collector ordering changes", async () => {
  const items = monitorInterfaces();
  const screen = await render(
    <div style={{ width: 896 }}>
      <ResourceNetworkInterfaces interfaces={items} history={interfaceMonitorHistory()} />
    </div>,
  );
  try {
    const en0 = screen.getByRole("region", { name: "en0 network interface", exact: true });
    const original = en0.element();
    const originalHeight = original.getBoundingClientRect().height;
    const summary = en0.getByLabelText("Details for en0", { exact: true });
    (summary.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(en0.getByText("1,500 B", { exact: true })).toBeVisible();
    const updated = items.toReversed().map((item) =>
      Object.assign({}, item, {
        receivedBytesPerSecond: interfaceMetric(item.name === "en0" ? 0 : 2000),
      }),
    );
    await screen.rerender(
      <div style={{ width: 896 }}>
        <ResourceNetworkInterfaces interfaces={updated} history={interfaceMonitorHistory()} />
      </div>,
    );
    expect(en0.element()).toBe(original);
    expect(original.querySelector("details")!.open).toBe(true);
    expect(
      screen
        .getByRole("heading", { level: 3 })
        .elements()
        .map((heading) => heading.textContent),
    ).toEqual(["awdl0", "bridge0", "en0"]);
    await summary.click();
    expect(original.getBoundingClientRect().height).toBeCloseTo(originalHeight);
    const toggle = screen.getByRole("button", { name: "Show interface history", exact: true });
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelectorAll('[data-slot="interface-history"]')).toHaveLength(0);
    expect(en0.element()).toBe(original);
    await toggle.click();
    expect(document.querySelectorAll('[data-slot="interface-history"]')).toHaveLength(3);
  } finally {
    await screen.unmount();
  }
});

it("does not confuse unknown measurements with genuine zero or show disconnected history", async () => {
  const items = monitorInterfaces();
  const missing = {
    ...items[0]!,
    receivedBytesPerSecond: interfaceMetric(0, "unsupported"),
    transmittedBytesPerSecond: interfaceMetric(0, "stale"),
  };
  const screen = await render(
    <ResourceNetworkInterfaces
      interfaces={[missing, items[1]!]}
      history={interfaceMonitorHistory()}
    />,
  );
  try {
    const en0 = screen.getByRole("region", { name: "en0 network interface", exact: true });
    expect(en0.getByText("0.00 B/s", { exact: true }).elements()).toHaveLength(0);
    await expect
      .element(en0.getByText("Network measurements unavailable", { exact: true }))
      .toBeVisible();
    expect(
      screen
        .getByRole("region", { name: "bridge0 network interface", exact: true })
        .getByText("0.00 B/s", { exact: true })
        .elements(),
    ).toHaveLength(2);
    await screen.rerender(
      <ResourceNetworkInterfaces
        interfaces={items}
        history={interfaceMonitorHistory()}
        current={false}
      />,
    );
    expect(screen.getByRole("img", { name: /network history/ }).elements()).toHaveLength(0);
    expect(screen.getByRole("img", { name: "Link up", exact: true }).elements()).toHaveLength(0);
    const unknown = en0.getByRole("img", { name: "Link unavailable", exact: true });
    await expect.element(unknown).toHaveAttribute("title", "Link unavailable");
    expect(unknown.element().classList.contains("bg-muted-foreground")).toBe(true);
    expect(getComputedStyle(unknown.element()).animationName).toBe("none");
    expect(document.querySelector(".animate-breathe")).toBeNull();
  } finally {
    await screen.unmount();
  }
});
