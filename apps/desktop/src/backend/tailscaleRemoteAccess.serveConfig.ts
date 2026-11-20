import {
  collectServeHandlers,
  parseLoopbackRootProxyPort,
  type ServeHandlerEntry,
} from "@bigbud/shared/tailscaleServe.config";
export { collectServeHandlers, parseLoopbackRootProxyPort };
export type { ServeHandlerEntry };

/**
 * Read-only interpretation of `tailscale serve status --json` for the desktop
 * backend. Each desktop channel only ever creates one Serve handler: HTTPS
 * `<httpsPort>` `/` proxying to `http://127.0.0.1:<backendPort>`, where
 * `httpsPort` is the channel's own listener. Everything else in the config,
 * including other channels' listeners, belongs to someone else and is left
 * untouched.
 */
const ROOT_HANDLER_PATH = "/";

/** This desktop's Serve listener and the loopback port it should forward to. */
export interface ServeTarget {
  readonly backendPort: number;
  readonly httpsPort: number;
}

export type ServeMappingAssessment =
  /** The channel's HTTPS `/` proxies to this backend. */
  | { readonly kind: "current"; readonly otherHandlerCount: number }
  /** The channel's HTTPS `/` still proxies to the port bigbud recorded configuring earlier. */
  | { readonly kind: "stale"; readonly stalePort: number }
  /**
   * The channel's HTTPS `/` belongs to something bigbud did not record
   * configuring. `loopbackPort` is set when it is a loopback proxy (possibly an
   * unrecorded earlier bigbud, possibly another local service).
   */
  | { readonly kind: "foreign"; readonly loopbackPort: number | null }
  /** No HTTPS `/` handler exists on the channel's listener. */
  | { readonly kind: "none" };

function isOnListener(entry: ServeHandlerEntry, httpsPort: number): boolean {
  return entry.listener.endsWith(`:${httpsPort}`);
}

function isHttpsRoot(entry: ServeHandlerEntry, httpsPort: number): boolean {
  return isOnListener(entry, httpsPort) && entry.path === ROOT_HANDLER_PATH;
}

function isOwnRoot(entry: ServeHandlerEntry, ownPort: number, httpsPort: number): boolean {
  return (
    isHttpsRoot(entry, httpsPort) &&
    entry.proxy !== null &&
    parseLoopbackRootProxyPort(entry.proxy) === ownPort
  );
}

/**
 * `ownedPort` is the port bigbud last configured on this listener (see the
 * ownership store). A loopback mapping to any other port is treated as another
 * service's.
 */
export function assessServeMapping(
  serveConfig: unknown,
  target: ServeTarget,
  ownedPort: number | null = null,
): ServeMappingAssessment {
  const handlers = collectServeHandlers(serveConfig);
  // Only the channel's HTTPS `/` counts: pairing links address
  // `https://<host>[:<httpsPort>]` with no path, so a handler for this backend
  // on another listener or path would leave that origin served by something else.
  const root = handlers.find((entry) => isHttpsRoot(entry, target.httpsPort));
  if (!root) {
    return { kind: "none" };
  }
  const rootPort = root.proxy === null ? null : parseLoopbackRootProxyPort(root.proxy);
  if (rootPort === target.backendPort) {
    return { kind: "current", otherHandlerCount: handlers.length - 1 };
  }
  return rootPort !== null && rootPort === ownedPort
    ? { kind: "stale", stalePort: rootPort }
    : { kind: "foreign", loopbackPort: rootPort };
}

/**
 * True when bigbud's handler is the only handler on its own HTTPS listener, so
 * turning that listener off removes nothing else. Other listeners (other
 * channels or services) are unaffected by `--https=<httpsPort> off`.
 */
export function isOnlyOwnHandlerOnListener(
  serveConfig: unknown,
  ownPort: number,
  httpsPort: number,
): boolean {
  const onListener = collectServeHandlers(serveConfig).filter((entry) =>
    isOnListener(entry, httpsPort),
  );
  return (
    onListener.length === 1 && onListener.every((entry) => isOwnRoot(entry, ownPort, httpsPort))
  );
}

export function describeServeMappingError(
  assessment: ServeMappingAssessment,
  target: ServeTarget,
): string | null {
  switch (assessment.kind) {
    case "current":
      return null;
    case "stale":
      return `Tailscale Serve points to 127.0.0.1:${assessment.stalePort}, but this desktop backend now runs on port ${target.backendPort}. Enable Tailscale Serve again to update it.`;
    case "foreign":
      return describeForeignServeMapping(assessment.loopbackPort, target.httpsPort);
    case "none":
      return "Tailscale Serve is not exposing this desktop backend.";
  }
}

export function describeForeignServeMapping(
  loopbackPort: number | null,
  httpsPort: number,
): string {
  return loopbackPort === null
    ? `Tailscale Serve's HTTPS port ${httpsPort} is used by another service, so it is not exposing this desktop backend.`
    : `Tailscale Serve's HTTPS port ${httpsPort} already forwards "/" to 127.0.0.1:${loopbackPort}, which bigbud did not set up, so bigbud left it unchanged. If that service is no longer needed, remove only that route (check "tailscale serve status" first; removing it stops whatever uses it), then enable again.`;
}

/** Copy for a foreign handler that local evidence ties to another bigbud backend. */
export function describeBigbudServeMapping(
  loopbackPort: number,
  httpsPort: number,
  ownerLabel: string,
): string {
  return `Tailscale Serve's HTTPS port ${httpsPort} already forwards "/" to 127.0.0.1:${loopbackPort}, which looks like ${ownerLabel} that this app did not set up. bigbud left it unchanged. Choose Take over to point this address at this app instead.`;
}

function listenerPort(listener: string): string {
  return listener.slice(listener.lastIndexOf(":") + 1);
}

/** Up to three other routes on bigbud's own listener, described as `path → target` without hostnames. */
export function describeOtherServeRoutes(
  serveConfig: unknown,
  ownPort: number,
  httpsPort: number,
): string {
  const others = collectServeHandlers(serveConfig).filter(
    (entry) => isOnListener(entry, httpsPort) && !isOwnRoot(entry, ownPort, httpsPort),
  );
  const listed = others
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.path} on port ${listenerPort(entry.listener)} → ${entry.proxy ?? "file or text"}`,
    );
  const more = others.length > 3 ? ` and ${others.length - 3} more` : "";
  return `${listed.join("; ")}${more}`;
}
