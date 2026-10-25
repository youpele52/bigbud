import "../../index.css";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useResourceMonitorStore } from "~/stores/resource-monitor/resourceMonitor.store";
import { SystemMonitorPage } from "./SystemMonitorPage";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import type { MonitorScope } from "./MonitorScopeToggle";

vi.mock("../standalone/StandaloneChatPageShell", () => ({
  StandaloneChatPageShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div className="flex flex-col" style={{ height: 700, width: 900 }}>
      {header}
      {children}
    </div>
  ),
}));
vi.mock("../standalone/StandaloneChatPageHeader", () => ({
  StandaloneChatPageHeader: () => <header className="h-12 shrink-0">System Monitor</header>,
}));

const subscribe = vi.fn(async () => 1);
const unsubscribe = vi.fn(async () => {});
let screen: Awaited<ReturnType<typeof render>> | undefined;
const originalBridge = window.desktopBridge;
beforeEach(() => {
  subscribe.mockClear();
  unsubscribe.mockClear();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      systemMonitorSubscribe: subscribe,
      systemMonitorUnsubscribe: unsubscribe,
      systemMonitorUpdate: async () => {},
      onSystemMonitorEvent: () => () => {},
    },
  });
  useResourceMonitorStore.setState({
    snapshot: null,
    connection: "connecting",
    reason: null,
    appReason: null,
    collectionStatus: null,
  });
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: originalBridge });
});

it("keeps scope controls visible and starts monitoring behind one centered startup loader", async () => {
  screen = await render(<SystemMonitorPage scope="system" onScopeChange={() => {}} />);
  await expect
    .element(screen.getByRole("button", { name: "Monitor bigbud resources" }))
    .toBeVisible();
  await expect.poll(() => subscribe.mock.calls.length).toBe(1);
  const loader = document.querySelector(".animate-pulse-slow")!;
  expect(loader).not.toBeNull();
  const body = loader.closest('[data-slot="standalone-page-loading"]')!.getBoundingClientRect();
  const logo = loader.getBoundingClientRect();
  expect(body.height).toBeGreaterThan(400);
  expect((logo.top + logo.bottom) / 2).toBeCloseTo((body.top + body.bottom) / 2, 0);
  const snapshot = appMonitorSnapshot();
  delete snapshot.appResources;
  delete snapshot.memoryTotalBytes;
  useResourceMonitorStore.setState({
    snapshot: {
      ...snapshot,
      summaryStatus: "warming",
      processStatus: "warming",
    },
    connection: "connected",
  });
  await expect.element(screen.getByText("Darwin · 27.0.1 · arm64", { exact: true })).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  expect(subscribe).toHaveBeenCalledTimes(1);
});

it("reveals available bigbud data without waiting for histories or all measurements", async () => {
  screen = await render(<SystemMonitorPage scope="bigbud" onScopeChange={() => {}} />);
  await expect.poll(() => subscribe.mock.calls.length).toBe(1);
  expect(document.querySelector(".animate-pulse-slow")).not.toBeNull();
  useResourceMonitorStore.setState({ snapshot: appMonitorSnapshot(), connection: "connected" });
  await expect.element(screen.getByText("Core bigbud", { exact: true })).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  await expect
    .element(screen.getByText("Waiting for history", { exact: true }).first())
    .toBeVisible();
  useResourceMonitorStore.setState({ connection: "connecting" });
  await expect.element(screen.getByText("Core bigbud", { exact: true })).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
});

it.each(["system", "bigbud"] as const)(
  "ends loading on collection failure in %s scope",
  async (scope: MonitorScope) => {
    screen = await render(<SystemMonitorPage scope={scope} onScopeChange={() => {}} />);
    useResourceMonitorStore.setState({
      connection: "connected",
      collectionStatus: {
        state: "failed",
        attempts: 1,
        retryAfterMs: 0,
        reason: "sampling failed",
        epoch: 1,
      },
    });
    await expect.element(screen.getByRole("button", { name: "Retry collection" })).toBeVisible();
    expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  },
);

it("shows the desktop-only diagnostic instead of indefinite loading without a bridge", async () => {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
  screen = await render(<SystemMonitorPage scope="system" onScopeChange={() => {}} />);
  await expect
    .element(screen.getByText(/System Monitor is available in the desktop app/))
    .toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
});

it("does not suppress missing app-sample diagnostics or expose stale totals", async () => {
  screen = await render(<SystemMonitorPage scope="bigbud" onScopeChange={() => {}} />);
  const snapshot = appMonitorSnapshot();
  delete snapshot.memoryTotalBytes;
  useResourceMonitorStore.setState({
    snapshot: { ...snapshot, sampledAtMs: 12000 },
    connection: "connected",
  });
  expect(document.querySelector(".animate-pulse-slow")).not.toBeNull();
  useResourceMonitorStore.setState({ appReason: "Restart the desktop app" });
  await expect.element(screen.getByText(/Restart the desktop app/)).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  expect(screen.getByText("18.40%", { exact: true }).elements()).toHaveLength(0);
});

it("reveals usable host RAM in bigbud scope while app samples are still pending", async () => {
  screen = await render(<SystemMonitorPage scope="bigbud" onScopeChange={() => {}} />);
  const snapshot = appMonitorSnapshot();
  delete snapshot.appResources;
  useResourceMonitorStore.setState({ snapshot, connection: "connected" });
  await expect.element(screen.getByText("Waiting for a fresh bigbud sample")).toBeVisible();
  await expect.element(screen.getByText(/16.00 GiB/).first()).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
});
