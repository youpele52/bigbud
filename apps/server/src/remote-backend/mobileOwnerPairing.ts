import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import {
  canonicalMobileOwnerOrigin,
  decodeMobileOwnerPairingInput,
  MOBILE_OWNER_PAIRING_MAX_BYTES,
  MOBILE_OWNER_PAIRING_PATH,
} from "./mobileOwnerPairing.protocol.ts";
import { readMobileOwnerJson } from "./mobileOwnerRequest.ts";

/** Owner-client UDS only. Authentication is supplied by the enclosing client router. */
export const mobileOwnerPairingRoute = HttpRouter.add(
  "POST",
  MOBILE_OWNER_PAIRING_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const gateway = yield* Effect.serviceOption(RemoteMobileGatewayStatus);
    if (config.mode !== "remote" || !config.remoteMobile || Option.isNone(gateway))
      return HttpServerResponse.text("Mobile access is unavailable", { status: 503 });
    const enabled = (yield* settings.getSettings).mobileRemoteControl.enabled;
    if (!enabled || !(yield* gateway.value.ready))
      return HttpServerResponse.text("Mobile access is unavailable", { status: 503 });
    const externalOrigin = gateway.value.verifiedExternalOrigin;
    if (!externalOrigin)
      return HttpServerResponse.text("Mobile target is unavailable", { status: 503 });
    canonicalMobileOwnerOrigin(externalOrigin);
    const input = yield* readMobileOwnerJson(
      MOBILE_OWNER_PAIRING_MAX_BYTES,
      decodeMobileOwnerPairingInput,
    );
    if (!input) return HttpServerResponse.text("Invalid pairing request", { status: 400 });
    if (input.backendOrigin !== externalOrigin)
      return HttpServerResponse.text("Mobile target does not match gateway configuration", {
        status: 409,
      });
    const identity = yield* RemoteBackendIdentityService;
    if (input.authorityId !== identity.authority.authorityId)
      return HttpServerResponse.text("Backend authority does not match", { status: 409 });
    const mobile = yield* MobileRemoteControl;
    const pairing = yield* mobile.createPairing({
      scope: input.scope,
      baseUrl: input.backendOrigin,
      backendBaseUrl: input.backendOrigin,
    });
    return yield* HttpServerResponse.json(pairing, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.text("Mobile pairing is unavailable", { status: 503 })),
    ),
  ),
);
