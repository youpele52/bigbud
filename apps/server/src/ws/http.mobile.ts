import {
  MobilePairingExchangeRequest,
  MobilePairingExchangeResponse,
  MobilePairingStatus,
} from "@bigbud/contracts/server/mobile";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl";
import { makeCorsMiddleware } from "./http.cors";

const PAIRING_PREFIX = "/api/mobile/pairing/";

function parsePairingId(pathname: string): string | null {
  if (!pathname.startsWith(PAIRING_PREFIX)) {
    return null;
  }
  const suffix = pathname.slice(PAIRING_PREFIX.length);
  const [pairingId] = suffix.split("/");
  return pairingId && pairingId.length > 0 ? pairingId : null;
}

const decodeMobilePairingExchangeRequest = Schema.decodeUnknownSync(MobilePairingExchangeRequest);

const mobilePairingCors = makeCorsMiddleware({
  allowedHeaders: ["content-type"],
  allowedMethods: ["GET", "POST", "OPTIONS"],
  maxAge: 600,
});

export const mobilePairingRouteLayer = HttpRouter.add(
  "GET",
  `${PAIRING_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const pairingId = parsePairingId(url.value.pathname);
    if (!pairingId) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const mobileRemoteControl = yield* MobileRemoteControl;
    const status = yield* mobileRemoteControl.getPairingStatus(pairingId);
    if (status === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.json(
      Schema.encodeSync(MobilePairingStatus)({
        pairingId: status.pairingId,
        scope: status.scope,
        expiresAt: status.expiresAt,
        enabled: status.enabled,
        available: status.available,
      }),
    );
  }),
);

export const mobilePairingExchangeRouteLayer = HttpRouter.add(
  "POST",
  `${PAIRING_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    if (!url.value.pathname.endsWith("/exchange")) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const pairingId = parsePairingId(url.value.pathname);
    if (!pairingId) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const body = yield* request.json.pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decodeMobilePairingExchangeRequest(value),
          catch: () => null,
        }),
      ),
    );
    if (body === null) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const mobileRemoteControl = yield* MobileRemoteControl;
    const session = yield* mobileRemoteControl
      .exchangePairing({
        pairingId,
        secret: body.secret,
        label: body.label,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (session === null) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const websocketProtocol = url.value.protocol === "https:" ? "wss:" : "ws:";
    const websocketUrl = `${websocketProtocol}//${url.value.host}/mobile-ws?token=${encodeURIComponent(session.token)}`;
    return yield* HttpServerResponse.json(
      Schema.encodeSync(MobilePairingExchangeResponse)({
        sessionId: session.sessionId,
        sessionToken: session.token,
        scope: session.scope,
        expiresAt: session.expiresAt,
        websocketUrl,
      }),
    );
  }),
);

export const mobilePairingRoutesLayer = Layer.mergeAll(
  mobilePairingRouteLayer,
  mobilePairingExchangeRouteLayer,
).pipe(Layer.provide(HttpRouter.middleware(mobilePairingCors, { global: true })));
