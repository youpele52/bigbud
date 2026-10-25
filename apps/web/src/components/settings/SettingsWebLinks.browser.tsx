import "../../index.css";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { registerBrowserLinkRouter } from "../../lib/openLink.navigation";
import { openLink } from "../../lib/openLink";
import { setLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "../../hooks/useSettings.storage";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";
import { useRightPanelTabsStore } from "../../stores/rightPanel/rightPanelTabs.store";
import { RightPanelHost } from "../right-panel/RightPanelHost";
import { MobileRemoteControlSettingsSection } from "./MobileRemoteControlSettingsSection";
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";

vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    shell: { openExternal: openLink },
    server: { listMobileRemoteSessions: async () => ({ sessions: [] }) },
  }),
  readNativeApi: () => undefined,
}));

afterEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
  vi.restoreAllMocks();
});

it.each([
  ["remote", "https://bigbud.app/docs/#advanced-features"],
  ["providers", "https://help.router-for.me/introduction/quick-start.html"],
] as const)(
  "shows a browser host after clicking %s settings documentation",
  async (section, url) => {
    removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
    useRightPanelTabsStore.setState({
      openTabs: [],
      activeTabId: null,
      activeKind: null,
      rightPanelOpen: false,
    });
    const root = createRootRoute({ component: Outlet });
    const chat = createRoute({
      getParentRoute: () => root,
      id: "_chat",
      component: RightPanelHost,
    });
    const index = createRoute({ getParentRoute: () => chat, path: "/" });
    const remote = createRoute({
      getParentRoute: () => root,
      path: "/settings/remote",
      component: MobileRemoteControlSettingsSection,
    });
    const providers = createRoute({
      getParentRoute: () => root,
      path: "/settings/providers",
      component: ProvidersSettingsSection,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [`/settings/${section}`] }),
      routeTree: root.addChildren([chat.addChildren([index]), remote, providers]),
      Wrap: ({ children }) =>
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AppAtomRegistryProvider, undefined, children),
        ),
    });
    const unregister = registerBrowserLinkRouter(router);
    await router.load();
    const mounted = await render(<RouterProvider router={router} />);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      if (section === "providers")
        await page
          .getByRole("button", { name: /CLIProxyAPI/ })
          .first()
          .click();
      const link =
        section === "remote"
          ? page.getByRole("link", { name: "Get step-by-step setup help" })
          : page.getByRole("button", { name: "CLIProxyAPI setup guide" });
      // Disabled links must leave settings in place and invoke the browser immediately.
      setLocalStorageItem(
        CLIENT_SETTINGS_STORAGE_KEY,
        { ...DEFAULT_CLIENT_SETTINGS, openWebLinksInApp: false },
        ClientSettingsSchema,
      );
      await link.click();
      expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
      expect(router.state.location.pathname).toBe(`/settings/${section}`);
      setLocalStorageItem(
        CLIENT_SETTINGS_STORAGE_KEY,
        { ...DEFAULT_CLIENT_SETTINGS, openWebLinksInApp: true },
        ClientSettingsSchema,
      );
      await link.click();
      await expect.poll(() => router.state.location.pathname).toBe("/");
      await expect.element(page.getByRole("textbox", { name: /url|address/i })).toBeVisible();
      await expect.element(page.getByRole("textbox", { name: /url|address/i })).toHaveValue(url);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.unmount();
      unregister();
      queryClient.clear();
    }
  },
);
