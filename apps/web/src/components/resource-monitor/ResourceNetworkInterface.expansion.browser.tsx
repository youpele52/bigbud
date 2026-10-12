import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { interfaceHistoryKey } from "~/stores/resource-monitor/resourceMonitor.interfaceHistory";
import { ResourceNetworkInterfaces } from "./ResourceNetworkInterfaces";
import {
  interfaceMonitorHistory,
  monitorInterfaces,
  interfaceMetric,
} from "./ResourceNetworkInterfaces.fixtures";

it.each([1200, 340])("opens a keyboard-accessible larger live view at %s px", async (width) => {
  await page.viewport(width, 900);
  const items = monitorInterfaces();
  const history = interfaceMonitorHistory();
  const screen = await render(<ResourceNetworkInterfaces interfaces={items} history={history} />);
  try {
    const card = screen.getByRole("region", { name: "en0 network interface", exact: true });
    const trigger = card.getByRole("button", { name: "Expand en0 network interface", exact: true });
    await expect.element(trigger).toHaveAttribute("aria-haspopup", "dialog");
    const compactHeight = card
      .getByRole("img", { name: "en0 network history", exact: true })
      .element()
      .getBoundingClientRect().height;
    // Zoom remains useful even when the compact histories have been hidden.
    await screen.getByRole("button", { name: "Show interface history", exact: true }).click();
    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    const dialog = page.getByRole("dialog", { name: "en0 network interface", exact: true });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByRole("img", { name: "Link up", exact: true }))
      .toHaveAttribute("title", "Link up");
    await userEvent.keyboard("{Tab}");
    expect(dialog.element().contains(document.activeElement)).toBe(true);
    const chart = dialog.getByRole("img", { name: "en0 network history", exact: true });
    await expect.element(chart).toBeVisible();
    expect(chart.element().getBoundingClientRect().height).toBeGreaterThan(compactHeight * 2);
    expect(chart.element().querySelectorAll(".recharts-area-curve")).toHaveLength(2);
    expect(dialog.element().querySelector("details")).toBeNull();
    for (const label of [
      "Downloaded total",
      "Uploaded total",
      "MTU",
      "Packets received",
      "Packets transmitted",
      "Receive errors",
      "Transmit errors",
    ])
      await expect.element(dialog.getByText(label, { exact: true })).toBeVisible();
    expect(dialog.element().scrollWidth).toBeLessThanOrEqual(width);
    const originalPath = chart.element().querySelector(".recharts-area-curve")!.getAttribute("d");
    const updated = {
      ...items[0]!,
      receivedBytesPerSecond: interfaceMetric(2048),
      transmittedBytesPerSecond: interfaceMetric(1024),
      mtuBytes: interfaceMetric(9000),
      receiveErrors: interfaceMetric(7),
      receivedTotalBytes: interfaceMetric(100 * 1024 ** 3),
      linkState: { value: "down", status: "ready" as const, sampledAtMs: 2000 },
    };
    const nextHistory = {
      ...history,
      [interfaceHistoryKey(updated)]: [
        { sequence: 31, value: 2048, sentValue: -1024 },
        { sequence: 32, value: 8192, sentValue: -4096 },
      ],
    };
    await screen.rerender(
      <ResourceNetworkInterfaces interfaces={[...items.slice(1), updated]} history={nextHistory} />,
    );
    const rates = dialog.getByRole("group", { name: "Network transfer rates", exact: true });
    await expect.element(rates.getByText("2.00 KiB/s", { exact: true })).toBeVisible();
    await expect.element(rates.getByText("1.00 KiB/s", { exact: true })).toBeVisible();
    await expect.element(dialog.getByText("9,000 B", { exact: true })).toBeVisible();
    await expect.element(dialog.getByText("7", { exact: true })).toBeVisible();
    await expect.element(dialog.getByText("100.00 GiB", { exact: true })).toBeVisible();
    await expect.element(dialog.getByRole("img", { name: "Link down", exact: true })).toBeVisible();
    expect(
      dialog
        .getByRole("img", { name: "Link down", exact: true })
        .element()
        .classList.contains("bg-destructive"),
    ).toBe(true);
    await expect
      .poll(() => chart.element().querySelector(".recharts-area-curve")!.getAttribute("d"))
      .not.toBe(originalPath);
    const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
    if (directory)
      await dialog.screenshot({ path: `${directory}/interface-expanded-${width}.png` });
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await trigger.click();
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
  } finally {
    await screen.unmount();
  }
});

it("keeps expanded unknown and disconnected rates honest and removes missing interfaces", async () => {
  await page.viewport(1200, 900);
  const items = monitorInterfaces();
  const missing = {
    ...items[0]!,
    receivedBytesPerSecond: interfaceMetric(0, "unsupported"),
    transmittedBytesPerSecond: interfaceMetric(0, "stale"),
    mtuBytes: interfaceMetric(0, "denied"),
  };
  const history = interfaceMonitorHistory();
  const screen = await render(
    <ResourceNetworkInterfaces interfaces={[missing]} history={history} />,
  );
  try {
    await screen.getByRole("button", { name: "Expand en0 network interface", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "en0 network interface", exact: true });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByText("Network measurements unavailable", { exact: true }))
      .toBeVisible();
    expect(dialog.element().querySelector('dd[title="denied"]')!.textContent).toBe("—");
    expect(dialog.getByText("0.00 B/s", { exact: true }).elements()).toHaveLength(0);
    expect(
      dialog.getByRole("img", { name: "en0 network history", exact: true }).elements(),
    ).toHaveLength(0);
    await screen.rerender(<ResourceNetworkInterfaces interfaces={items} history={history} />);
    await expect
      .element(dialog.getByRole("img", { name: "en0 network history", exact: true }))
      .toBeVisible();
    await screen.rerender(
      <ResourceNetworkInterfaces interfaces={items} history={history} current={false} />,
    );
    await expect
      .element(dialog.getByRole("img", { name: "Link unavailable", exact: true }))
      .toBeVisible();
    expect(
      dialog.getByRole("img", { name: "en0 network history", exact: true }).elements(),
    ).toHaveLength(0);
    expect(dialog.getByText("1.40 MiB/s", { exact: true }).elements()).toHaveLength(0);
    expect(dialog.element().querySelector(".animate-breathe")).toBeNull();
    await screen.rerender(
      <ResourceNetworkInterfaces interfaces={items.slice(1)} history={history} />,
    );
    await expect.element(dialog).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand en0 network interface" }).elements(),
    ).toHaveLength(0);
    await screen.getByRole("button", { name: "Expand bridge0 network interface" }).click();
    const idle = page.getByRole("dialog", { name: "bridge0 network interface", exact: true });
    await expect.element(idle).toBeVisible();
    expect(
      idle
        .getByRole("group", { name: "Network transfer rates" })
        .getByText("0.00 B/s", { exact: true })
        .elements(),
    ).toHaveLength(2);
    await expect
      .element(idle.getByRole("img", { name: "bridge0 network history", exact: true }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});
