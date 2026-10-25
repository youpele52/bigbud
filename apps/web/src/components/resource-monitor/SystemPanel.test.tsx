import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SystemPanel } from "./SystemPanel";
import { useResourceMonitor } from "./useResourceMonitor";

const mockPreferences = vi.hoisted(() => ({ visible: ["cpu", "memory"] }));
const mockDetails = vi.hoisted(() => ({ visible: ["ipAddress"] as string[] }));

vi.mock("~/stores/resource-monitor/resourceMonitorPreferences.store", () => ({
  RESOURCE_WIDGETS: ["cpu", "memory", "disk", "network", "temperature"],
  useResourceWidgetPreferences: (selector: (state: object) => unknown) =>
    selector({ visible: mockPreferences.visible, toggle: vi.fn(), move: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./useResourceMonitor", () => ({
  useResourceMonitor: vi.fn(() => ({
    snapshot: null,
    history: { cpu: [], memory: [], network: [] },
    connection: "connecting",
    reason: null,
    collectionStatus: null,
  })),
}));
vi.mock("~/stores/resource-monitor/resourceMonitorDetails.store", () => ({
  useResourceDetailPreferences: (selector: (state: { visible: string[] }) => unknown) =>
    selector(mockDetails),
}));

describe("SystemPanel", () => {
  it("requests sensors only when its Temperature widget is visible", () => {
    mockPreferences.visible = ["cpu", "memory"];
    renderToStaticMarkup(<SystemPanel visible />);
    expect(useResourceMonitor).toHaveBeenLastCalledWith(true, false, false);
    mockPreferences.visible = [];
    renderToStaticMarkup(<SystemPanel visible />);
    expect(useResourceMonitor).toHaveBeenLastCalledWith(true, false, false);
    mockPreferences.visible = ["temperature"];
    renderToStaticMarkup(<SystemPanel visible />);
    expect(useResourceMonitor).toHaveBeenLastCalledWith(true, false, true);
  });

  it("hides the host address line when its detail preference is disabled", () => {
    const visible = mockDetails.visible;
    mockDetails.visible = [];

    try {
      const markup = renderToStaticMarkup(<SystemPanel visible />);
      expect(markup).not.toContain("Desktop computer · desktop host");
    } finally {
      mockDetails.visible = visible;
    }
  });
});
