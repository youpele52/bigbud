interface BrowserLinkRouter {
  readonly state: { readonly matches: ReadonlyArray<{ readonly routeId: string }> };
  navigate: (options: { to: "/" }) => Promise<void>;
}

let browserLinkRouter: BrowserLinkRouter | undefined;

/** Connect non-component link handlers to the application router without importing its route tree. */
export function registerBrowserLinkRouter(router: BrowserLinkRouter): () => void {
  browserLinkRouter = router;
  return () => {
    if (browserLinkRouter === router) browserLinkRouter = undefined;
  };
}

/** The browser host lives in the chat layout, not in settings or other standalone routes. */
export function ensureBrowserLinkHost(): Promise<void> | undefined {
  const router = browserLinkRouter;
  if (!router || router.state.matches.some((match) => match.routeId === "/_chat")) return;
  return router.navigate({ to: "/" });
}
