import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { useResourceDetailPreferences } from "~/stores/resource-monitor/resourceMonitorDetails.store";

it("pages the remote inventory after sorting by reported CPU", async () => {
  const original = useResourceDetailPreferences.getState().visible;
  useResourceDetailPreferences.setState({ visible: ["processes"] });
  const snapshot = appMonitorSnapshot();
  snapshot.processStatus = "ready";
  snapshot.processRows = Array.from({ length: 101 }, (_, index) => ({
    pid: index + 1,
    name: index === 100 ? "busy-worker" : "idle-worker",
    status: "S",
    startTimeSeconds: 1,
    runTimeSeconds: 1,
    residentBytes: 1024,
    virtualBytes: 1024,
    cpuPercent: { value: index === 100 ? 90 : 0, status: "ready", sampledAtMs: 1 },
  }));
  const screen = await render(
    <SystemMonitorHostView
      remote={{
        name: "VPS",
        state: {
          snapshot,
          connection: "connected",
          reason: null,
          history: { cpu: [], memory: [], network: [] },
        },
      }}
    />,
  );
  try {
    const table = screen.getByRole("table");
    await expect.element(table.getByText("busy-worker")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    await screen.getByRole("button", { name: "Next" }).click();
    await expect.element(table.getByText("busy-worker")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  } finally {
    await screen.unmount();
    useResourceDetailPreferences.setState({ visible: original });
  }
});
