import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { EMPTY_APP_HISTORY } from "~/stores/resource-monitor/resourceMonitor.appHistory";
import { useResourceDetailPreferences } from "~/stores/resource-monitor/resourceMonitorDetails.store";
import { useResourceMonitor } from "./useResourceMonitor";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { sensorHistories, temperatureSnapshot } from "./ResourceTemperatures.fixtures";

vi.mock("./useResourceMonitor", () => ({ useResourceMonitor: vi.fn() }));
const originalDetails = useResourceDetailPreferences.getState().visible;
afterEach(() => useResourceDetailPreferences.setState({ visible: originalDetails }));

it("wires per-sensor histories into the host view and stops exposing them when collection fails or demand ends", async () => {
  await page.viewport(1200, 1400);
  useResourceDetailPreferences.setState({ visible: ["temperatures"] });
  vi.mocked(useResourceMonitor).mockReturnValue({
    snapshot: temperatureSnapshot(),
    history: { cpu: [], memory: [], network: [] },
    appHistory: EMPTY_APP_HISTORY,
    diskHistory: {},
    interfaceHistory: {},
    temperatureHistory: sensorHistories(),
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
    expect(useResourceMonitor).toHaveBeenLastCalledWith(true, false, true);
    const card = screen.getByRole("region", { name: "Temperatures", exact: true });
    expect(card.element().getBoundingClientRect().width).toBe(896);
    await expect
      .element(card.getByRole("img", { name: "PMU TP2g temperature history", exact: true }))
      .toBeVisible();
    await card
      .getByRole("button", { name: "Expand PMU TP2g temperature sensor", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "PMU TP2g temperature sensor", exact: true });
    await expect.element(dialog).toBeVisible();
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, true),
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
    expect(dialog.getByRole("img").elements()).toHaveLength(0);
    expect(dialog.getByText("61.64 °C", { exact: true }).elements()).toHaveLength(0);
    expect(dialog.element().querySelector('[data-loading="true"]')).toBeNull();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(card.getByText("Hottest: —", { exact: true })).toBeVisible();
    useResourceDetailPreferences.setState({ visible: [] });
    await screen.rerender(
      <div style={{ width: 896 }}>
        <SystemMonitorHostView />
      </div>,
    );
    expect(useResourceMonitor).toHaveBeenLastCalledWith(true, false, false);
    await expect.element(card).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
