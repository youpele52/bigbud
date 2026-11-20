import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../startup/config.ts";
import {
  matchesMobileGatewayCredential,
  MOBILE_GATEWAY_CREDENTIAL_HEADER,
} from "../mobile/mobileGatewayCredential.ts";
import { mobilePairingRoutesLayer } from "../ws/http.mobile.ts";
import { makeMobileWebsocketRpcRouteLayer } from "../ws/ws.mobile.ts";
import { BootstrapCommandLockService } from "../ws/wsBootstrap.lock.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { remoteMobileDescriptor } from "./mobileDescriptor.ts";

/** The entire upstream router is authenticated, including unknown or future routes. */
export const remoteMobileAuthorizationLive = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const credential =
      config.mode === "remote" && config.remoteMobile
        ? Redacted.value(config.remoteMobile.gatewayCredential)
        : undefined;
    return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (
          !credential ||
          !matchesMobileGatewayCredential(
            credential,
            request.headers[MOBILE_GATEWAY_CREDENTIAL_HEADER],
          )
        )
          return HttpServerResponse.text("Forbidden", { status: 403 });
        return yield* app;
      });
  }),
  { global: true },
);

export function makeRemoteMobileDescriptorRoute(backendVersion: string) {
  return HttpRouter.add(
    "GET",
    "/api/mobile/handshake",
    Effect.gen(function* () {
      const identity = yield* RemoteBackendIdentityService;
      const settings = yield* ServerSettingsService;
      const gateway = yield* Effect.serviceOption(RemoteMobileGatewayStatus);
      const consent = yield* settings.getSettings.pipe(
        Effect.map((value) => value.mobileRemoteControl.enabled),
        Effect.catch(() => Effect.succeed(false)),
      );
      const ready = Option.isSome(gateway) ? yield* gateway.value.ready : false;
      return yield* HttpServerResponse.json(
        remoteMobileDescriptor(identity, backendVersion, consent && ready),
        { headers: { "cache-control": "no-store" } },
      );
    }),
  ).pipe(Layer.provide(remoteMobileAuthorizationLive));
}

/** Private Rust-gateway upstream only. Public HTTP/assets remain owned by Rust. */
export function makeRemoteMobileRoutesLayer(backendVersion: string) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const lock = yield* BootstrapCommandLockService;
      return Layer.mergeAll(
        makeRemoteMobileDescriptorRoute(backendVersion),
        mobilePairingRoutesLayer,
        makeMobileWebsocketRpcRouteLayer(lock),
      ).pipe(Layer.provide(remoteMobileAuthorizationLive));
    }),
  );
}
