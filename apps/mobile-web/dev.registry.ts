import { randomUUID } from "node:crypto";

import {
  publishMobileDevRecord,
  type MobileDevRegistry,
  type MobileDevRecord,
} from "@bigbud/shared/DevMobileRegistry";
import {
  isLocalDevRequest,
  MOBILE_DEV_HEALTH_PATH,
  sendDevJson,
} from "@bigbud/shared/DevMobileRegistry.http";
import type { Plugin, ViteDevServer } from "vite";

const publications = new WeakMap<NonNullable<ViteDevServer["httpServer"]>, Promise<unknown>>();

export async function waitForMobileDevPublication(
  server: ViteDevServer["httpServer"],
): Promise<void> {
  if (server) await publications.get(server);
}

export function mobileDevRegistryPlugin(registry: MobileDevRegistry): Plugin {
  const activeCleanups = new Set<() => Promise<void>>();
  return {
    name: "bigbud-mobile-dev-registry",
    apply: "serve",
    configureServer(server) {
      if (server.config.base !== "/" && server.config.base !== "/mobile/") {
        server.config.logger.warn(
          `Automatic Local pairing is unavailable for base ${JSON.stringify(server.config.base)}; use / or /mobile/ for the mobile app's pairing routes.`,
        );
        return;
      }
      const host = server.config.server.host;
      if (
        typeof host === "string" &&
        !["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host)
      ) {
        server.config.logger.warn(
          "Automatic Local pairing verifies loopback listeners only. If this host is not loopback-accessible, use a reachable Custom mobile URL.",
        );
      }
      const httpServer = server.httpServer;
      if (!httpServer) throw new Error("Mobile development requires an HTTP listener");
      const nonce = randomUUID();
      let closed = false;
      let publication: Promise<(() => Promise<void>) | undefined> | undefined;
      let cleanupPromise: Promise<void> | undefined;
      function cleanup(): Promise<void> {
        closed = true;
        cleanupPromise ??= (async () => {
          try {
            const removeRecord = await publication;
            await removeRecord?.();
          } catch (error) {
            server.config.logger.warn(
              `Mobile development registry cleanup failed: ${String(error)}`,
            );
          } finally {
            activeCleanups.delete(cleanup);
          }
        })();
        return cleanupPromise;
      }
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== MOBILE_DEV_HEALTH_PATH) return next();
        if (req.method !== "GET" || !isLocalDevRequest(req)) {
          sendDevJson(res, 403, { error: "Local development requests only" });
          return;
        }
        sendDevJson(res, 200, { nonce });
      });
      httpServer.once("listening", () => {
        const address = httpServer.address();
        if (!address || typeof address === "string") return;
        const record: MobileDevRecord = { port: address.port, nonce, ownerPid: process.pid };
        activeCleanups.add(cleanup);
        const pending = publishMobileDevRecord(registry, record);
        publications.set(httpServer, pending);
        publication = pending.catch((error: unknown) => {
          if (closed) return;
          server.config.logger.error(`Mobile development discovery unavailable: ${String(error)}`);
          return undefined;
        });
      });
      httpServer.once("close", () => {
        void cleanup();
      });
    },
    async closeBundle() {
      // Vite awaits this hook before CLI/signal exit. Newly configured restart
      // listeners are not active yet, so the previous server cannot remove them.
      await Promise.all(Array.from(activeCleanups, (cleanup) => cleanup()));
    },
  };
}
