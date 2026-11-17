import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Data from "effect/Data";
import { version } from "../../package.json" with { type: "json" };
import type { BackendInstanceShape } from "../startup/backendInstance.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import { resolveRemoteMobileConfiguration } from "../startup/config.remoteMobile.ts";
import { prepareRemoteMobileSocket } from "./mobileSocket.ts";
import { makeRemoteMobileRoutesLayer } from "./mobileRoutes.ts";
import { remoteUnixHttpServerLive } from "../server.platform.ts";
import { serveIsolatedRemoteRoutes } from "../server.remote.listener.ts";

export class MobileUpstreamError extends Data.TaggedError("MobileUpstreamError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const unavailable = (cause?: unknown) =>
  new MobileUpstreamError({ message: "The private mobile upstream socket is unavailable.", cause });
const operation = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable });

/**
 * The single private upstream for the gateway: refuse any existing pathname, serve the isolated
 * mobile routes with `gatewayCredential`, then seal the socket (owned, 0600, single link).
 * A fresh activation passes a new random credential; a successor passes the bootstrap credential
 * returned by native Resume so the already-running original gateway can authenticate again.
 * Scoped: HTTP finalization closes before the socket is released.
 */
export const serveSealedMobileUpstream = Effect.fn("serveSealedMobileUpstream")(function* (
  config: ServerConfigShape,
  owner: BackendInstanceShape,
  gatewayCredential: string,
  assertAllowed: () => Promise<void>,
) {
  const remoteMobile = yield* Effect.try({
    try: () =>
      resolveRemoteMobileConfiguration({
        mode: config.mode,
        enabled: true,
        gatewayCredential,
        clientToken: config.authToken,
      }),
    catch: unavailable,
  });
  if (!remoteMobile) return yield* unavailable();
  const selectedConfig: ServerConfigShape = Object.freeze({
    ...config,
    remoteMobile: Object.freeze(remoteMobile),
  });
  const socket = yield* Effect.acquireRelease(
    operation(async () => {
      await assertAllowed();
      return prepareRemoteMobileSocket(owner.stateDir, owner.assertHeld, {
        existing: "refuse-existing",
      });
    }),
    (socket) => operation(socket.release).pipe(Effect.orDie),
  );
  const serving = serveIsolatedRemoteRoutes(makeRemoteMobileRoutesLayer(version)).pipe(
    Layer.provide(remoteUnixHttpServerLive(socket.bindPath)),
    Layer.provide(Layer.succeed(ServerConfig, selectedConfig)),
  );
  // Scoped HTTP finalization is installed after socket ownership, so it closes first.
  yield* Layer.build(serving);
  yield* operation(async () => {
    await assertAllowed();
    await socket.seal();
  });
  return selectedConfig;
});
