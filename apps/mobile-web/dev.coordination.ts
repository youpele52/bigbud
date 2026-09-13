import {
  readDevPortReservations,
  reserveDevPort,
  type DevPortCoordinator,
} from "@bigbud/shared/DevPortCoordinator";
import type { Plugin, ViteDevServer } from "vite";

import { isMobileDevPortAvailable } from "./dev.listener.ports.ts";
import { waitForMobileDevPublication } from "./dev.registry.ts";

export class MobileDevPortUnavailable extends Error {}

// The same inline plugin instance is reused by Vite restart. Its new generation
// is configured before the previous one closes, keeping the reservation alive
// across the restart gap without reading or modifying Vite's private fields.
export function mobilePortCoordinationPlugin(
  coordinator: DevPortCoordinator,
  siblingWebPort: number | undefined,
): Plugin {
  let generations = 0;
  let lease: Awaited<ReturnType<typeof reserveDevPort>> | undefined;
  return {
    name: "bigbud-mobile-port-coordination",
    apply: "serve",
    enforce: "post",
    configureServer: {
      order: "post",
      handler(server) {
        let closed = false;
        let registered = false;
        let closing: Promise<void> | undefined;
        let pending: Promise<ViteDevServer> | undefined;
        const admission = new AbortController();
        const close = server.close.bind(server);
        server.close = () => {
          if (closing) return closing;
          closed = true;
          admission.abort(new Error("Mobile development listener closed during startup"));
          closing = (async () => {
            // Abort queued admission, but wait for an already admitted bind to
            // settle before teardown. Closing must never be followed by a bind.
            await pending?.catch(() => undefined);
            try {
              await close();
            } finally {
              if (registered && --generations === 0) {
                const previous = lease;
                lease = undefined;
                await previous?.release();
              }
            }
          })();
          return closing;
        };
        const listen = server.listen.bind(server);
        server.listen = (port, isRestart) => {
          if (closed) return Promise.reject(admission.signal.reason);
          if (pending) return pending;
          pending = coordinator
            .withLock(async () => {
              admission.signal.throwIfAborted();
              const candidate = port ?? server.config.server.port;
              if (
                !Number.isInteger(candidate) ||
                candidate === undefined ||
                candidate < 1 ||
                candidate > 65535
              ) {
                throw new Error("Mobile development requires a valid coordinated port");
              }
              const reservations = await readDevPortReservations(coordinator);
              if (
                candidate === siblingWebPort ||
                reservations.some(
                  (r) => r.port === candidate && r.token !== lease?.reservation.token,
                ) ||
                (!server.httpServer?.listening && !(await isMobileDevPortAvailable(candidate)))
              ) {
                throw new MobileDevPortUnavailable(
                  `Mobile development port ${candidate} is unavailable`,
                );
              }
              if (lease?.reservation.port !== candidate) {
                admission.signal.throwIfAborted();
                const previous = lease;
                lease = await reserveDevPort(coordinator, candidate, "mobile");
                await previous?.release();
              }
              // The reservation check, actual bind and nonce publication form one
              // critical section. Expensive createServer work happens before it.
              const result = await listen(candidate, isRestart);
              await waitForMobileDevPublication(server.httpServer);
              admission.signal.throwIfAborted();
              return result;
            }, admission.signal)
            .finally(() => {
              pending = undefined;
            });
          return pending;
        };
        // This final post-hook runs after the other configure post-hooks. A
        // failed construction must not acquire a reference to the shared lease.
        return () => {
          if (!closed) {
            registered = true;
            generations++;
          }
        };
      },
    },
  };
}
