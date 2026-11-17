import { BootstrapCommandLockLive } from "./ws/wsBootstrap.lock.ts";
import { version } from "../package.json" with { type: "json" };
import { makeRemoteMobileRoutesLayer } from "./remote-backend/mobileRoutes.ts";
import { prepareRemoteMobileSocket } from "./remote-backend/mobileSocket.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { serveIsolatedRemoteRoutes } from "./server.remote.listener.ts";

import { RemoteCallbackBinding } from "./server.remote.callbackBinding.ts";

import { BackendInstance } from "./startup/backendInstance.ts";
import { ServerConfig } from "./startup/config.ts";
import { ServerRuntimeStartup } from "./startup/serverRuntimeStartup.ts";
import { remoteUnixHttpServerLive } from "./server.platform.ts";
import { makeRemoteClientRoutesLayer } from "./server.remote.routes.ts";
import { RemoteCallbackRoutesLive } from "./server.remote.callbacks.ts";
import { ThreadToolModelSourcesLive } from "./orchestration-tools/ThreadOrchestrationTools.modelSources.ts";
import { RemoteAgentLocalControlLive } from "./remote-agent/remoteAgentLocalControl.layer.ts";
import { prepareRemoteClientSocket } from "./remote-backend/clientSocket.ts";
import { RemoteBackendAuthorityError } from "./remote-backend/authority.record.ts";
import { RemoteMobileActivationLive } from "./server.mobileActivation.ts";

function socketOperation<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RemoteBackendAuthorityError
        ? cause
        : new RemoteBackendAuthorityError(
            "unsafe-state",
            "The remote client socket could not be prepared.",
          ),
  });
}

/** Two independent routers: authenticated Unix clients and thread-token loopback callbacks. */
export const RemoteServerApplicationLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const owner = yield* BackendInstance;
    const callback = yield* RemoteCallbackBinding;
    const socket = yield* Effect.acquireRelease(
      socketOperation(() => prepareRemoteClientSocket(config.stateDir, owner.assertHeld)),
      (socket) => socketOperation(socket.release).pipe(Effect.ignoreCause({ log: true })),
    );

    const mobileSocket = config.remoteMobile
      ? yield* Effect.acquireRelease(
          socketOperation(() => prepareRemoteMobileSocket(config.stateDir, owner.assertHeld)),
          (socket) => socketOperation(socket.release).pipe(Effect.ignoreCause({ log: true })),
        )
      : undefined;
    const mobileServing = mobileSocket
      ? serveIsolatedRemoteRoutes(makeRemoteMobileRoutesLayer(version)).pipe(
          Layer.provide(remoteUnixHttpServerLive(mobileSocket.bindPath)),
        )
      : Layer.empty;
    const serving = Layer.mergeAll(
      mobileServing,
      serveIsolatedRemoteRoutes(makeRemoteClientRoutesLayer).pipe(
        Layer.provide(remoteUnixHttpServerLive(socket.bindPath)),
      ),
      // Callback tokens retain their own existing per-thread authentication and capability policy.
      serveIsolatedRemoteRoutes(RemoteCallbackRoutesLive).pipe(
        Layer.provide(Layer.succeedServices(callback.httpServices)),
      ),
      ThreadToolModelSourcesLive,
      RemoteAgentLocalControlLive,
      // Default-off: attaches the native mobile controller only when proof inputs exist.
      RemoteMobileActivationLive,
    ).pipe(Layer.provideMerge(BootstrapCommandLockLive));

    return Layer.effectDiscard(
      Effect.gen(function* () {
        yield* socketOperation(socket.seal);
        if (mobileSocket) yield* socketOperation(mobileSocket.seal);
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    ).pipe(Layer.provideMerge(serving));
  }),
);
