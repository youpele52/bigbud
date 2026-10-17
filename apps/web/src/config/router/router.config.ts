import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { routeTree } from "../../routeTree.gen";
import { registerBrowserLinkRouter } from "../../lib/openLink.navigation";

export function getRouter(history: RouterHistory) {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    history,
    context: {
      queryClient,
    },
    Wrap: ({ children }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AppAtomRegistryProvider, undefined, children),
      ),
  });
  registerBrowserLinkRouter(router);
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
