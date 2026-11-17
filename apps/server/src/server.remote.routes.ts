import { mobileOwnerPairingRoute } from "./remote-backend/mobileOwnerPairing.ts";
import { mobileOwnerActivationRoute } from "./remote-backend/mobileOwnerActivation.ts";
import { RemoteMobileConsentJournalLive } from "./remote-backend/mobileConsentEnable.ts";
import { RemoteMobileNativeInputsLive } from "./remote-backend/mobileGatewayActivation.inputs.ts";
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
      // The same inputs layer value the activation attach reads, so one build reads it once.
      mobileOwnerActivationRoute.pipe(
        Layer.provide(Layer.merge(RemoteMobileNativeInputsLive, RemoteMobileConsentJournalLive)),
      ),
      // The authenticated client socket is the only route granting D10 setup authority.
      makeWebsocketRpcRouteLayer(withBootstrapCommandLock, { remoteClientRouter: true }),
      attachmentsRouteLayer,
      projectFaviconRouteLayer,
      workspacePdfViewerRouteLayer,
      workspaceFilePreviewRouteLayer,
    ).pipe(Layer.provide(remoteClientAuthorizationLive));
  }),
);
