import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  RemoteBackendClientHandshake,
  REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";

import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteTerminalAvailability } from "./terminalAvailability.ts";
import { RemoteRuntimeUpdate } from "./Services/RemoteRuntimeUpdate.ts";
import { Option } from "effect";
import {
  authorizeRemoteClientRequest,
  REMOTE_CLIENT_HANDSHAKE_PATH,
} from "./clientAuthorization.ts";

/** Apply to the entire client router, including unknown paths and future route additions. */
export const remoteClientAuthorization = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const result = authorizeRemoteClientRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      expectedToken: config.authToken,
    });
    if (result === "unauthorized") return HttpServerResponse.text("Unauthorized", { status: 401 });
    if (result === "incompatible")
      return HttpServerResponse.text("Incompatible remote client RPC revision", { status: 426 });
    return yield* app;
  });

export const remoteClientAuthorizationLive = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      remoteClientAuthorization(app).pipe(Effect.provideService(ServerConfig, config));
  }),
  { global: true },
);

export function makeRemoteClientHandshakeRoute(backendVersion: string) {
  return HttpRouter.add(
    "GET",
    REMOTE_CLIENT_HANDSHAKE_PATH,
    Effect.gen(function* () {
      const identity = yield* RemoteBackendIdentityService;
      const terminals = yield* Effect.serviceOption(RemoteTerminalAvailability);
      const updates = yield* Effect.serviceOption(RemoteRuntimeUpdate);
      return yield* HttpServerResponse.json(
        Schema.encodeSync(RemoteBackendClientHandshake)({
          handshakeRevision: REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION,
          clientRpcRevision: REMOTE_BACKEND_CLIENT_RPC_REVISION,
          authority: identity.authority,
          installationFingerprint: identity.installationFingerprint,
          backendVersion,
          capabilities: {
            persistentTerminals: Option.isSome(terminals)
              ? yield* terminals.value.available
              : false,
            visibleBrowser: false,
            computerUse: false,
            hostOsIntegration: false,
            mobileAccess: false,
            // Composed only by the remote backend (M3 WP-4D).
            runtimeUpdates: Option.isSome(updates),
          },
        }),
      );
    }),
  ).pipe(Layer.provide(remoteClientAuthorizationLive));
}
