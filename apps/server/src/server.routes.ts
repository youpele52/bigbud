import { Effect, Layer } from "effect";

import { makeBootstrapCommandLock } from "./ws/wsBootstrap.lock.ts";
import { makeWebsocketRpcRouteLayer } from "./ws/ws.ts";
import { makeMobileWebsocketRpcRouteLayer } from "./ws/ws.mobile.ts";
import {
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
  workspacePdfViewerRouteLayer,
  workspaceFilePreviewRouteLayer,
} from "./ws/http.ts";
import { mobilePairingRoutesLayer } from "./ws/http.mobile.ts";
import { mobileWebStaticRouteLayer } from "./ws/http.mobileWeb.ts";
import { pluginAssetRouteLayer } from "./ws/http.plugins.ts";
import { threadOrchestrationToolsRouteLayer } from "./ws/http.threadTools.ts";

export const makeWsRpcTransportLockBindings = Effect.gen(function* () {
  const withBootstrapCommandLock = yield* makeBootstrapCommandLock();
  return {
    desktop: withBootstrapCommandLock,
    mobile: withBootstrapCommandLock,
  } as const;
});

export const makeRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const transportLocks = yield* makeWsRpcTransportLockBindings;
    return Layer.mergeAll(
      attachmentsRouteLayer,
      otlpTracesProxyRouteLayer,
      projectFaviconRouteLayer,
      pluginAssetRouteLayer,
      workspacePdfViewerRouteLayer,
      workspaceFilePreviewRouteLayer,
      mobilePairingRoutesLayer,
      mobileWebStaticRouteLayer,
      staticAndDevRouteLayer,
      threadOrchestrationToolsRouteLayer,
      makeWebsocketRpcRouteLayer(transportLocks.desktop),
      makeMobileWebsocketRpcRouteLayer(transportLocks.mobile),
    );
  }),
);
