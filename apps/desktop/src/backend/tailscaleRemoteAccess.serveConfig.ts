import {
  collectServeHandlers,
  parseLoopbackRootProxyPort,
  type ServeHandlerEntry,
} from "@bigbud/shared/tailscaleServe.config";
export { collectServeHandlers, parseLoopbackRootProxyPort };
export type { ServeHandlerEntry };

/**
 * Read-only interpretation of `tailscale serve status --json` for the desktop
 * backend. bigbud only ever creates one Serve handler: HTTPS 443 `/` proxying to
 * `http://127.0.0.1:<backendPort>`. Everything else in the config belongs to the
 * user or another app and must be left untouched.
 */
const DEFAULT_HTTPS_SERVE_PORT_SUFFIX = ":443";
const ROOT_HANDLER_PATH = "/";

export type ServeMappingAssessment =
  /** HTTPS 443 `/` proxies to this backend. */
  | { readonly kind: "current"; readonly otherHandlerCount: number }
  /** HTTPS 443 `/` still proxies to the port bigbud recorded configuring earlier. */
  | { readonly kind: "stale"; readonly stalePort: number }
  /**
   * HTTPS 443 `/` belongs to something bigbud did not record configuring.
   * `loopbackPort` is set when it is a loopback proxy (possibly an unrecorded
   * earlier bigbud, possibly another local service).
   */
  | { readonly kind: "foreign"; readonly loopbackPort: number | null }
  /** No HTTPS 443 `/` handler exists. */
  | { readonly kind: "none" };

function isDefaultHttpsRoot(entry: ServeHandlerEntry): boolean {
  return (
    entry.listener.endsWith(DEFAULT_HTTPS_SERVE_PORT_SUFFIX) && entry.path === ROOT_HANDLER_PATH
  );
}

/**
 * `ownedPort` is the port bigbud last configured (see the ownership store). A
 * loopback mapping to any other port is treated as another service's.
 */
export function assessServeMapping(
  serveConfig: unknown,
  backendPort: number,
  ownedPort: number | null = null,
): ServeMappingAssessment {
  const handlers = collectServeHandlers(serveConfig);
  // Only HTTPS 443 `/` counts: pairing links address `https://<host>` with no
  // port or path, so a handler for this backend on another listener or path
  // would leave that origin served by something else.
  const root = handlers.find(isDefaultHttpsRoot);
  if (!root) {
    return { kind: "none" };
  }
  const rootPort = root.proxy === null ? null : parseLoopbackRootProxyPort(root.proxy);
  if (rootPort === backendPort) {
    return { kind: "current", otherHandlerCount: handlers.length - 1 };
  }
  return rootPort !== null && rootPort === ownedPort
    ? { kind: "stale", stalePort: rootPort }
    : { kind: "foreign", loopbackPort: rootPort };
}

/** True when the handler for `port` is the only Serve handler, so turning off HTTPS 443 removes nothing else. */
export function isOnlyOwnHttpsHandler(serveConfig: unknown, port: number): boolean {
  const handlers = collectServeHandlers(serveConfig);
  return (
    handlers.length === 1 &&
    handlers.every(
      (entry) =>
        isDefaultHttpsRoot(entry) &&
        entry.proxy !== null &&
        parseLoopbackRootProxyPort(entry.proxy) === port,
    )
  );
}

export function describeServeMappingError(
  assessment: ServeMappingAssessment,
  backendPort: number,
): string | null {
  switch (assessment.kind) {
    case "current":
      return null;
    case "stale":
      return `Tailscale Serve points to 127.0.0.1:${assessment.stalePort}, but this desktop backend now runs on port ${backendPort}. Enable Tailscale Serve again to update it.`;
    case "foreign":
      return describeForeignServeMapping(assessment.loopbackPort);
    case "none":
      return "Tailscale Serve is not exposing this desktop backend.";
  }
}

export function describeForeignServeMapping(loopbackPort: number | null): string {
  return loopbackPort === null
    ? "Tailscale Serve's HTTPS address is used by another service, so it is not exposing this desktop backend."
    : `Tailscale Serve's HTTPS address already forwards "/" to 127.0.0.1:${loopbackPort}, which bigbud did not set up, so bigbud left it unchanged. If that is an older bigbud you no longer use, remove only that route (check "tailscale serve status" first; removing it stops whatever uses it), then enable again.`;
}

function listenerPort(listener: string): string {
  return listener.slice(listener.lastIndexOf(":") + 1);
}

/** Up to three other Serve routes, described as `path → target` without hostnames. */
export function describeOtherServeRoutes(serveConfig: unknown, ownPort: number): string {
  const others = collectServeHandlers(serveConfig).filter(
    (entry) =>
      !(
        isDefaultHttpsRoot(entry) &&
        entry.proxy !== null &&
        parseLoopbackRootProxyPort(entry.proxy) === ownPort
      ),
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
