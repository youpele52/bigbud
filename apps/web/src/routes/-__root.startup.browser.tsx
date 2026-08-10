import "../index.css";

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../stores/main";

const readNativeApiMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => <main data-testid="route-outlet">Route outlet</main>,
}));

vi.mock("../rpc/nativeApi", () => ({ readNativeApi: readNativeApiMock }));
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({ hasSeenFileAccessPrompt: true }),
}));
vi.mock("../hooks/useWindowMaterial", () => ({ useWindowMaterial: () => undefined }));
vi.mock("../rpc/serverState", () => ({ useServerConfig: () => null }));
vi.mock("../components/layout/StartupSplash", () => ({
  StartupSplash: ({ className = "" }: { className?: string }) => (
    <div data-testid="startup-splash" className={className} />
  ),
}));
vi.mock("../components/layout/CommandPalette", () => ({
  CommandPalette: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/layout/AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { children: ReactNode }) => (
    <aside data-testid="app-shell">{children}</aside>
  ),
}));
vi.mock("../components/ui/toast", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  AnchoredToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/WebSocketConnectionSurface", () => ({
  WebSocketConnectionCoordinator: () => null,
  WebSocketConnectionSurface: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./-__root.bootstrap", () => ({ ServerStateBootstrap: () => null }));
vi.mock("./-__root.logic", () => ({ EventRouter: () => null }));
vi.mock("../components/SlowRpcAckToastCoordinator", () => ({
  SlowRpcAckToastCoordinator: () => null,
}));
vi.mock("../components/DesktopBackendStartupCoordinator", () => ({
  DesktopBackendStartupCoordinator: () => null,
}));
vi.mock("../components/plugins/PluginUpdateToastCoordinator", () => ({
  PluginUpdateToastCoordinator: () => null,
}));
vi.mock("../notifications/pendingApprovalCoordinator", () => ({
  PendingApprovalCoordinator: () => null,
}));
vi.mock("../notifications/taskCompletion", () => ({ TaskCompletionNotifications: () => null }));
vi.mock("../components/file-access/FileAccessPermissionDialog", () => ({
  FileAccessPermissionDialog: () => null,
}));
vi.mock("../components/computer-use/ComputerUseStartupRepairCoordinator", () => ({
  ComputerUseStartupRepairCoordinator: () => null,
}));

import { RootRouteView } from "./__root";

async function mountRoot() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(<RootRouteView />, { container: host });

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("RootRouteView startup", () => {
  beforeEach(() => {
    readNativeApiMock.mockReturnValue({});
    useStore.setState({ bootstrapComplete: false });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    readNativeApiMock.mockReset();
  });

  it("mounts the shell and outlet before bootstrap completes beneath an exiting splash", async () => {
    const mounted = await mountRoot();

    try {
      expect(document.querySelector('[data-testid="app-shell"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="route-outlet"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="startup-splash"]')).toBeTruthy();

      await vi.waitFor(
        () => expect(document.querySelector('[data-testid="startup-splash"]')).toBeNull(),
        { timeout: 1_000 },
      );

      useStore.setState({ bootstrapComplete: true });
      await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="startup-splash"]')).toBeNull(),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the full-screen splash only when the native API is unavailable", async () => {
    readNativeApiMock.mockReturnValue(undefined);
    const mounted = await mountRoot();

    try {
      expect(document.querySelector('[data-testid="startup-splash"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="app-shell"]')).toBeNull();
      expect(document.querySelector('[data-testid="route-outlet"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
