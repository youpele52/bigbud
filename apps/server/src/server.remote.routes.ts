import { mobileOwnerPairingRoute } from "./remote-backend/mobileOwnerPairing.ts";
import { mobileOwnerActivationRoutesLive } from "./remote-backend/mobileOwnerActivation.routes.ts";
import { Effect, Layer } from "effect";
import { peerGrantOwnerRouteLayer } from "./remote-backend/peerGrantOwnerRoute.ts";

import { version } from "../package.json" with { type: "json" };
import { BootstrapCommandLockService } from "./ws/wsBootstrap.lock.ts";
import { makeWebsocketRpcRouteLayer } from "./ws/ws.ts";
import {
  attachmentsRouteLayer,
  projectFaviconRouteLayer,
  workspacePdfViewerRouteLayer,
  workspaceFilePreviewRouteLayer,
} from "./ws/http.ts";
import {
  makeRemoteClientHandshakeRoute,
  remoteClientAuthorizationLive,
} from "./remote-backend/clientRoutes.ts";

/** Deliberate remote client surface; provider callbacks live on a different listener/router. */
export const makeRemoteClientRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const withBootstrapCommandLock = yield* BootstrapCommandLockService;
    return Layer.mergeAll(
      makeRemoteClientHandshakeRoute(version),
      mobileOwnerPairingRoute,
      // Request-scoped consent journal; inputs come from the attach's single read.
      mobileOwnerActivationRoutesLive,
      // P8: owner-only peer grant issue/revoke/list (`bigbud peer`); never on the peer socket.
      peerGrantOwnerRouteLayer,
      // The authenticated client socket is the only route granting D10 setup authority.
      makeWebsocketRpcRouteLayer(withBootstrapCommandLock, { remoteClientRouter: true }),
      attachmentsRouteLayer,
      projectFaviconRouteLayer,
      workspacePdfViewerRouteLayer,
      workspaceFilePreviewRouteLayer,
    ).pipe(Layer.provide(remoteClientAuthorizationLive));
  }),
);
