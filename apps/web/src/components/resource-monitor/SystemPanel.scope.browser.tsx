import "../../index.css";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { SystemPanel } from "./SystemPanel";
import { appMonitorSnapshot } from "./BigbudResourceView.fixtures";
import { useResourceMonitor } from "./useResourceMonitor";
import { BigbudResourceView } from "./BigbudResourceView";
import { EMPTY_APP_HISTORY } from "~/stores/resource-monitor/resourceMonitor.appHistory";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { expectCenteredStatuses } from "../common/CenteredStatus.browser.utils";

function MonitorLink({
  children,
  to,
  search,
}: {
  children: ReactNode;
  to: string;
  search?: { monitorScope: string };
}) {
  return <a href={`${to}?monitorScope=${search?.monitorScope ?? "system"}`}>{children}</a>;
}
vi.mock("@tanstack/react-router", () => ({ Link: MonitorLink }));
vi.mock("./useResourceMonitor", () => ({ useResourceMonitor: vi.fn() }));

beforeEach(() => {
  vi.mocked(useResourceMonitor).mockReturnValue({
    snapshot: appMonitorSnapshot(),
    history: { cpu: [], memory: [], network: [] },
    appHistory: EMPTY_APP_HISTORY,
    appReason: null,
    connection: "connected",
    reason: null,
    collectionStatus: null,
  });
});

it.each(["panel", "host", "bigbud"])(
  "centers loading states and retry messages in %s",
  async (scope) => {
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false),
      snapshot: null,
      connection: "connecting",
    });
    const content = () => (
      <div
        className="bg-background p-4 text-foreground"
        style={{ width: 340 }}
        data-testid="surface"
      >
        {scope === "panel" ? (
          <SystemPanel visible />
        ) : scope === "host" ? (
          <SystemMonitorHostView />
        ) : (
          <BigbudResourceView visible large />
        )}
      </div>
    );
    const screen = await render(content());
    try {
      const surface = screen.getByTestId("surface").element();
      expectCenteredStatuses(surface);
      expect(surface.querySelectorAll('[data-loading="true"]').length).toBeGreaterThan(1);
      const directory = import.meta.env.VITE_MONITOR_SCREENSHOT_DIR;
      if (directory)
        await screen
          .getByTestId("surface")
          .screenshot({ path: `${directory}/loading-${scope}-340.png` });
      vi.mocked(useResourceMonitor).mockReturnValue({
        ...useResourceMonitor(true, false, false),
        connection: "unavailable",
        reason: "Connection lost",
      });
      await screen.rerender(content());
      await expect
        .element(screen.getByRole("button", { name: "Retry", exact: true }))
        .toBeVisible();
      expectCenteredStatuses(surface);
      expect(surface.querySelectorAll('[data-loading="true"]')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  },
);

it.each(["panel", "host"])(
  "wires system memory history in the %s view and clears it when disconnected",
  async (scope) => {
    const snapshot = appMonitorSnapshot();
    snapshot.memoryUsedBytes = { value: 12 * 1024 ** 3, status: "ready", sampledAtMs: 1000 };
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false),
      snapshot,
      history: {
        cpu: [],
        network: [],
        memory: [
          { sequence: 1, value: 11 * 1024 ** 3 },
          { sequence: 2, value: 12 * 1024 ** 3 },
        ],
      },
    });
    const content = scope === "panel" ? <SystemPanel visible /> : <SystemMonitorHostView />;
    const screen = await render(<div style={{ width: 896 }}>{content}</div>);
    await expect
      .element(screen.getByRole("img", { name: "Memory history", exact: true }))
      .toBeVisible();
    vi.mocked(useResourceMonitor).mockReturnValue({
      ...useResourceMonitor(true, false, false),
      connection: "unavailable",
    });
    await screen.rerender(
      <div style={{ width: 896 }}>
        {scope === "panel" ? <SystemPanel visible /> : <SystemMonitorHostView />}
      </div>,
    );
    expect(
      screen.getByRole("img", { name: "Memory history", exact: true }).elements(),
    ).toHaveLength(0);
    await screen.unmount();
  },
);

it("uses the full monitor width for both scopes and remains fluid in narrow panels", async () => {
  await page.viewport(1400, 1400);
  const screen = await render(
    <div style={{ width: 1200 }} data-testid="wide-surface">
      <div data-testid="panel">
        <SystemPanel visible />
      </div>
      <div data-testid="full-view">
        <StandalonePageContent>Full monitor content</StandalonePageContent>
      </div>
    </div>,
  );
  const panel = screen.getByTestId("panel");
  const content = panel.element().firstElementChild!.firstElementChild as HTMLElement;
  const fullContent = screen.getByTestId("full-view").element().firstElementChild!
    .firstElementChild as HTMLElement;
  expect(content.getBoundingClientRect().width).toBe(fullContent.getBoundingClientRect().width);
  expect(content.getBoundingClientRect().left).toBe(fullContent.getBoundingClientRect().left);
  await panel.getByRole("button", { name: "Monitor bigbud resources" }).click();
  expect(content.getBoundingClientRect().width).toBe(fullContent.getBoundingClientRect().width);
  expect(content.getBoundingClientRect().left).toBe(fullContent.getBoundingClientRect().left);
  (screen.getByTestId("wide-surface").element() as HTMLElement).style.width = "340px";
  await panel.getByRole("button", { name: "Monitor system resources" }).click();
  expect(content.getBoundingClientRect().width).toBe(340);
  expect(content.scrollWidth).toBeLessThanOrEqual(340);
  await panel.getByRole("button", { name: "Monitor bigbud resources" }).click();
  expect(content.getBoundingClientRect().width).toBe(340);
  expect(content.scrollWidth).toBeLessThanOrEqual(340);
  await screen.unmount();
});

it("keeps both scopes inside one bounded vertical scroll container", async () => {
  const screen = await render(
    <div
      className="flex min-h-0 flex-col overflow-hidden"
      style={{ width: 1000, height: 180 }}
      data-testid="panel"
    >
      <SystemPanel visible />
    </div>,
  );
  const panel = screen.getByTestId("panel");
  const scroll = panel.element().firstElementChild as HTMLElement;
  for (const scope of ["system", "bigbud", "system"]) {
    await panel.getByRole("button", { name: `Monitor ${scope} resources` }).click();
    expect(panel.element().firstElementChild).toBe(scroll);
    expect(scroll.clientHeight).toBe(180);
    expect(getComputedStyle(scroll).overflowY).toBe("auto");
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    scroll.scrollTop = scroll.scrollHeight;
    expect(scroll.scrollTop).toBeGreaterThan(0);
  }
  await screen.unmount();
});

it("matches the full view's stacked charts and card dimensions in the right panel", async () => {
  const points = [
    { sequence: 1, value: 2 },
    { sequence: 2, value: 3 },
  ];
  vi.mocked(useResourceMonitor).mockReturnValue({
    ...useResourceMonitor(true, false, false, true),
    appHistory: { ...EMPTY_APP_HISTORY, cpu: points, memory: points },
  });
  const screen = await render(
    <div style={{ width: 896 }}>
      <div data-testid="panel">
        <SystemPanel visible />
      </div>
      <div className="p-4" data-testid="full-view">
        <BigbudResourceView visible large />
      </div>
    </div>,
  );
  const panel = screen.getByTestId("panel");
  const full = screen.getByTestId("full-view");
  await panel.getByRole("button", { name: "Monitor bigbud resources" }).click();
  for (const label of ["CPU", "Memory"]) {
    const history = panel.getByRole("img", { name: `${label} history` });
    const capacity = panel.getByRole("meter", {
      name: new RegExp(`^${label} capacity:`),
    });
    const reference = full.getByRole("img", { name: `${label} history` });
    expect(history.element().getBoundingClientRect().height).toBe(
      reference.element().getBoundingClientRect().height,
    );
    expect(history.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      capacity.element().getBoundingClientRect().bottom,
    );
    const card = history.element().closest('[data-slot="card"]')!.getBoundingClientRect();
    const fullCard = reference.element().closest('[data-slot="card"]')!.getBoundingClientRect();
    expect(card.width).toBe(fullCard.width);
    expect(card.height).toBe(fullCard.height);
  }
  await screen.unmount();
});

it("keeps panel scope independent and links to the matching detailed monitor", async () => {
  const screen = await render(
    <div style={{ display: "flex", gap: 20 }}>
      <div data-testid="first-panel" style={{ width: 420 }}>
        <SystemPanel visible />
      </div>
      <div data-testid="second-panel" style={{ width: 420 }}>
        <SystemPanel visible />
      </div>
    </div>,
  );
  const first = screen.getByTestId("first-panel");
  const second = screen.getByTestId("second-panel");
  await first.getByRole("button", { name: "Monitor bigbud resources" }).click();
  await expect.element(first.getByRole("heading", { name: "Core bigbud" })).toBeVisible();
  await expect
    .element(first.getByRole("heading", { name: "Including agents/tools" }))
    .toBeVisible();
  await expect
    .element(first.getByRole("link", { name: "Open bigbud Monitor" }))
    .toHaveAttribute("href", "/system-monitor?monitorScope=bigbud");
  await expect
    .element(second.getByRole("button", { name: "Monitor system resources" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(second.getByRole("link", { name: "Open System Monitor" })).toBeVisible();
  expect(useResourceMonitor).toHaveBeenCalledWith(true, false, false, true);
  await first.getByRole("button", { name: "Monitor system resources" }).click();
  await expect.element(first.getByRole("link", { name: "Open System Monitor" })).toBeVisible();
});
