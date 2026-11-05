import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { Route, redirectRetiredMarketplace } from "./_chat.plugins";
import { resolveStartupRouteIntent } from "./-__root.startup-restoration";

describe("retired marketplace routes (browser navigation)", () => {
  it.each(["/plugins", "/plugins/", "/plugins/openai-public%3Aexample"])(
    "redirects %s without interpreting it as a thread",
    async (pathname) => {
      const root = createRootRoute();
      const home = createRoute({ getParentRoute: () => root, path: "/" });
      const legacy = createRoute({
        getParentRoute: () => root,
        path: "plugins",
        beforeLoad: redirectRetiredMarketplace,
      });
      const detail = createRoute({ getParentRoute: () => legacy, path: "$pluginId" });
      const history = createMemoryHistory({ initialEntries: [pathname] });
      const router = createRouter({
        history,
        routeTree: root.addChildren([home, legacy.addChildren([detail])]),
        isServer: false,
      });
      await router.load();
      // Initial-load redirects complete in a subsequent navigation.
      await new Promise<void>((resolve) => {
        if (router.state.location.pathname === "/") return resolve();
        const unsubscribe = router.subscribe("onResolved", () => {
          unsubscribe();
          resolve();
        });
      });
      expect(router.state.location.pathname).toBe("/");
      expect(Route.options.beforeLoad).toBe(redirectRetiredMarketplace);
      expect(history.length).toBe(1);
      expect(resolveStartupRouteIntent(pathname)).toEqual({ kind: "non-thread" });
    },
  );
});
