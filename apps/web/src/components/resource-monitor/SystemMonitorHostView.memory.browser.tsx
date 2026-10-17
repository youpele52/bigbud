import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { EMPTY_APP_HISTORY } from "~/stores/resource-monitor/resourceMonitor.appHistory";
import { useResourceMonitor } from "./useResourceMonitor";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { memorySwapSnapshot } from "./ResourceMemorySwap.fixtures";

vi.mock("./useResourceMonitor", () => ({ useResourceMonitor: vi.fn() }));

it("wires RAM and Swap bars into the existing details card without replacing the main Memory gauge", async () => {
  await page.viewport(1200, 1400);
  vi.mocked(useResourceMonitor).mockReturnValue({
    snapshot: memorySwapSnapshot(),
    history: { cpu: [], memory: [], network: [] },
    appHistory: EMPTY_APP_HISTORY,
    diskHistory: {},
    interfaceHistory: {},
    temperatureHistory: {},
    appReason: null,
    connection: "connected",
    reason: null,
    collectionStatus: null,
  });
  const screen = await render(
    <div style={{ width: 896 }}>
      <SystemMonitorHostView />
    </div>,
  );
  try {
    const card = screen.getByRole("region", { name: "Memory and swap", exact: true });
    expect(card.element().getBoundingClientRect().width).toBeLessThan(448);
    await expect
      .element(card.getByRole("meter", { name: "RAM capacity used", exact: true }))
      .toBeVisible();
    await expect
      .element(card.getByRole("meter", { name: "Swap capacity used", exact: true }))
      .toBeVisible();
    const gauge = screen.getByRole("meter", { name: "Memory capacity used", exact: true });
    await expect.element(gauge).toBeVisible();
    expect(gauge.element().querySelector('[data-slot="gauge-needle"]')).not.toBeNull();
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false),
      connection: "unavailable",
    });
    await screen.rerender(
      <div style={{ width: 896 }}>
        <SystemMonitorHostView />
      </div>,
    );
    expect(card.getByRole("meter").elements()).toHaveLength(0);
    expect(card.element().querySelector('[data-loading="true"]')).toBeNull();
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false),
      connection: "connected",
      collectionStatus: {
        state: "failed",
        attempts: 1,
        retryAfterMs: 0,
        reason: "Collection failed",
        epoch: 1,
      },
    });
    await screen.rerender(
      <div style={{ width: 896 }}>
        <SystemMonitorHostView />
      </div>,
    );
    expect(card.getByRole("meter").elements()).toHaveLength(0);
    expect(card.element().querySelector('[data-loading="true"]')).toBeNull();
  } finally {
    await screen.unmount();
  }
});
