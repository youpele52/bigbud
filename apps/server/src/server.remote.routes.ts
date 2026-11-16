import { mobileOwnerPairingRoute } from "./remote-backend/mobileOwnerPairing.ts";
import { Effect, Layer } from "effect";

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
      makeWebsocketRpcRouteLayer(withBootstrapCommandLock),
      attachmentsRouteLayer,
      projectFaviconRouteLayer,
      workspacePdfViewerRouteLayer,
      workspaceFilePreviewRouteLayer,
    ).pipe(Layer.provide(remoteClientAuthorizationLive));
  }),
);
