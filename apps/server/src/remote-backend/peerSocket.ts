/**
 * Worker peer endpoint (WP-8B): a third owner-private Unix socket, separate from the client and
 * mobile sockets, serving only the peer router. Composed by the remote backend only.
 *
 * @module peerSocket
 */
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { PeerChildStarterLive } from "../peer-orchestration/peerWorker.starter.layer.ts";
import { PeerChildRepositoryLive } from "../persistence/Layers/PeerChildren.ts";
import { PeerGrantRepositoryLive } from "../persistence/Layers/PeerGrants.ts";
import { remoteUnixHttpServerLive } from "../server.platform.ts";
import { serveIsolatedRemoteRoutes } from "../server.remote.listener.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendAuthorityError } from "./authority.record.ts";
import { remotePeerRoutesLayer } from "./peerRoutes.ts";
import { preparePrivateRemoteSocket, type PrivateRemoteSocketOptions } from "./privateSocket.ts";

/** Fixed `remote-peer.sock` beside the client socket; mode 0600, hard-link published. */
export function prepareRemotePeerSocket(
  stateDir: string,
  assertHeld: () => Promise<void>,
  options?: PrivateRemoteSocketOptions,
) {
  return preparePrivateRemoteSocket(stateDir, assertHeld, "peer", options);
}

const socketOperation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RemoteBackendAuthorityError
        ? cause
        : new RemoteBackendAuthorityError(
            "unsafe-state",
            "The remote peer socket could not be prepared.",
          ),
  });

/** Binds, seals (0600 + publication) and serves the peer router; releases on scope close. */
export const RemotePeerSocketLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const owner = yield* BackendInstance;
    const socket = yield* Effect.acquireRelease(
      socketOperation(() => prepareRemotePeerSocket(config.stateDir, owner.assertHeld)),
      (prepared) => socketOperation(prepared.release).pipe(Effect.ignoreCause({ log: true })),
    );
    // Peer-only repositories, built once and provided to every peer request.
    // The child starter lives in this scope, so a start outlives the request that began it.
    const repositories = yield* Layer.build(
      Layer.mergeAll(
        PeerGrantRepositoryLive,
        PeerChildStarterLive.pipe(Layer.provideMerge(PeerChildRepositoryLive)),
      ),
    );
    const serving = serveIsolatedRemoteRoutes(
      remotePeerRoutesLayer.pipe(HttpRouter.provideRequest(Layer.succeedServices(repositories))),
    ).pipe(Layer.provide(remoteUnixHttpServerLive(socket.bindPath)));
    return Layer.effectDiscard(socketOperation(socket.seal)).pipe(Layer.provideMerge(serving));
  }),
);
