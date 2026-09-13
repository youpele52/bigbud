import {
  createMobileDevRegistry,
  discoverMobileDevUrl,
  type MobileDevRegistry,
} from "@bigbud/shared/DevMobileRegistry";
import {
  isLocalDevRequest,
  MOBILE_DEV_DISCOVERY_PATH,
  sendDevJson,
} from "@bigbud/shared/DevMobileRegistry.http";
import type { Plugin } from "vite";

export function mobileDiscoveryPlugin(repoRoot: string, registry?: MobileDevRegistry): Plugin {
  return {
    name: "bigbud-mobile-dev-discovery",
    apply: "serve",
    async configureServer(server) {
      const scopedRegistry = registry ?? (await createMobileDevRegistry(repoRoot));
      // Coalesce concurrent requests, but do not cache listener health across requests.
      let pending: Promise<string | null> | undefined;
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== MOBILE_DEV_DISCOVERY_PATH) return next();
        if (req.method !== "GET" || !isLocalDevRequest(req)) {
          sendDevJson(res, 403, { error: "Local development requests only" });
          return;
        }
        pending ??= discoverMobileDevUrl(scopedRegistry)
          .catch(() => null)
          .finally(() => {
            pending = undefined;
          });
        void pending.then((url) => sendDevJson(res, 200, { url }));
      });
    },
  };
}
