import * as Layer from "effect/Layer";
import { setTimeout as delay } from "node:timers/promises";
import { collectServeHandlers } from "@bigbud/shared/tailscaleServe.config";
import { canonicalMobileOwnerOrigin } from "./mobileOwnerPairing.protocol.ts";
import { probeMobileGatewayHttps } from "./mobileGatewayProbe.ts";
import { runLocalSupervisorCommand } from "./localSupervisorControl.runner.ts";
import {
  RemoteMobileGatewayRouteOwner,
  type MobileGatewayRouteInput,
  type MobileGatewayRouteOwnerShape,
} from "./mobileGatewayOwner.route.ts";

const CHECK_INTERVAL_MS = 1_000;
const MAX_VERIFIED_AGE_MS = 5_000;
const unavailable = () => new Error("The mobile HTTPS route could not be verified.");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exact hostname, listener and target; an unrelated HTTPS route never grants admission. */
export function assertMobileGatewayServeRoute(
  input: Pick<MobileGatewayRouteInput, "externalOrigin" | "port">,
  status: unknown,
  config: unknown,
): void {
  const origin = new URL(canonicalMobileOwnerOrigin(input.externalOrigin));
  if (origin.port !== "" || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    throw unavailable();
  if (
    !record(status) ||
    status.BackendState !== "Running" ||
    !record(status.Self) ||
    status.Self.Online !== true ||
    typeof status.Self.DNSName !== "string" ||
    status.Self.DNSName.replace(/\.$/, "").toLowerCase() !== origin.hostname ||
    !record(config) ||
    !record(config.TCP) ||
    !record(config.TCP["443"]) ||
    config.TCP["443"].HTTPS !== true
  )
    throw unavailable();
  const listener = `${origin.hostname}:443`;
  // Public Funnel exposure is incompatible with the required tailnet-only route.
  if (
    config.AllowFunnel !== undefined &&
    (!record(config.AllowFunnel) || Object.values(config.AllowFunnel).some((v) => v !== false))
  )
    throw unavailable();
  const handlers = collectServeHandlers(config);
  // More-specific routes could replace signed assets, pairing or WS while the root still matches.
  if (
    handlers.some(
      (entry) =>
        entry.listener === listener &&
        entry.path !== "/" &&
        ["/mobile", "/mobile-ws", "/api/mobile"].some(
          (path) =>
            entry.path === path ||
            entry.path.startsWith(`${path}/`) ||
            path.startsWith(`${entry.path.replace(/\/$/, "")}/`),
        ),
    )
  )
    throw unavailable();
  const matches = handlers.filter((entry) => entry.listener === listener && entry.path === "/");
  if (matches.length !== 1 || matches[0]!.proxy !== `http://127.0.0.1:${input.port}`)
    throw unavailable();
}

async function tailscaleJson(command: "status" | "serve", signal: AbortSignal): Promise<unknown> {
  const result = await runLocalSupervisorCommand(
    "/bin/sh",
    [
      "-c",
      command === "status" ? "exec tailscale status --json" : "exec tailscale serve status --json",
    ],
    {
      signal,
      timeoutMs: 1_000,
      maxBufferBytes: 64 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin", LANG: "C" },
    },
  );
  return JSON.parse(result.stdout);
}

async function checkRoute(input: MobileGatewayRouteInput, signal: AbortSignal): Promise<void> {
  const status = await tailscaleJson("status", signal);
  const config = await tailscaleJson("serve", signal);
  assertMobileGatewayServeRoute(input, status, config);
  await probeMobileGatewayHttps({ ...input, signal });
}

/** Internal dependency seam for deterministic lifecycle tests; the production Layer uses real IO. */
export function makeMobileGatewayRouteOwner(
  verify: typeof checkRoute = checkRoute,
  clock = { monotonic: () => performance.now(), wall: () => Date.now() },
): MobileGatewayRouteOwnerShape {
  return {
    async withRoute(input, operation, externalSignal) {
      // Clone before IO so caller mutation cannot change the admitted destination or identity.
      const fixed = structuredClone(input);
      canonicalMobileOwnerOrigin(fixed.externalOrigin);
      externalSignal.throwIfAborted();
      const controller = new AbortController();
      const signal = controller.signal;
      const abort = () => controller.abort();
      externalSignal.addEventListener("abort", abort, { once: true });
      if (externalSignal.aborted) abort();
      let observedAt = 0;
      let wallObservedAt = 0;
      let failure: unknown;
      let monitor: Promise<void> | undefined;
      let pending: Promise<void> | undefined;
      const verifyNow = (): Promise<void> =>
        (pending ??= (async () => {
          signal.throwIfAborted();
          const before = clock.monotonic();
          const wallBefore = clock.wall();
          await verify(fixed, AbortSignal.any([signal, AbortSignal.timeout(MAX_VERIFIED_AGE_MS)]));
          signal.throwIfAborted();
          const after = clock.monotonic();
          const wallAfter = clock.wall();
          if (
            after < before ||
            after - before > MAX_VERIFIED_AGE_MS ||
            wallAfter < wallBefore ||
            wallAfter - wallBefore > MAX_VERIFIED_AGE_MS
          )
            throw unavailable();
          // Age includes the entire observation cycle, rather than extending a slow stale read.
          observedAt = before;
          wallObservedAt = wallBefore;
        })().finally(() => {
          pending = undefined;
        }));
      try {
        await verifyNow();
        monitor = (async () => {
          try {
            while (!signal.aborted) {
              await delay(CHECK_INTERVAL_MS, undefined, { signal });
              await verifyNow();
            }
          } catch (cause) {
            if (!signal.aborted) {
              failure = cause;
              controller.abort();
            }
          }
        })();
        // Monitoring is owned before the final actual route/HTTPS reread and publication.
        await verifyNow();
        const result = await operation(
          {
            assertCurrent: async (callerSignal) => {
              callerSignal.throwIfAborted();
              signal.throwIfAborted();
              const age = clock.monotonic() - observedAt;
              const wallAge = clock.wall() - wallObservedAt;
              if (
                age < 0 ||
                age > MAX_VERIFIED_AGE_MS ||
                wallAge < 0 ||
                wallAge > MAX_VERIFIED_AGE_MS
              ) {
                controller.abort();
                throw unavailable();
              }
            },
          },
          signal,
        );
        if (failure) throw unavailable();
        signal.throwIfAborted();
        return result;
      } finally {
        controller.abort();
        externalSignal.removeEventListener("abort", abort);
        await monitor;
      }
    },
  };
}

/** Construction has no filesystem, CLI or network side effects. */
export const RemoteMobileGatewayRouteOwnerLive = Layer.succeed(
  RemoteMobileGatewayRouteOwner,
  makeMobileGatewayRouteOwner(),
);
