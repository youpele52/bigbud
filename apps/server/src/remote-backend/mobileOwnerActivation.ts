import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileConsentJournal } from "./mobileConsentEnable.ts";
import { RemoteMobileNativeInputsReport } from "./mobileGatewayActivation.inputs.ts";
import { RemoteMobileGatewayActivation } from "./mobileGatewayActivation.service.ts";
import {
  decodeMobileOwnerActivationRequest,
  MOBILE_OWNER_ACTIVATION_MAX_BYTES,
  MOBILE_OWNER_ACTIVATION_PATH,
  MobileOwnerActivateResult,
  MobileOwnerConsentResult,
  mobileOwnerRefusalStatus,
  MobileOwnerStatus,
  MobileOwnerRepairResult,
  MobileOwnerStopResult,
  type MobileOwnerRefusalCode,
} from "./mobileOwnerActivation.protocol.ts";
import { readMobileOwnerJson } from "./mobileOwnerRequest.ts";

const headers = { "cache-control": "no-store" };
const refuse = (code: MobileOwnerRefusalCode) =>
  HttpServerResponse.jsonUnsafe(
    { refused: code },
    { status: mobileOwnerRefusalStatus[code], headers },
  );
const reply = <S extends Schema.Encoder<unknown>>(schema: S, value: S["Type"]) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeUnknownSync(schema)(value), { headers });

const status = Effect.fn("MobileOwnerActivation.status")(function* (authorityId: string) {
  const activation = yield* Effect.serviceOption(RemoteMobileGatewayActivation);
  const report = yield* Effect.serviceOption(RemoteMobileNativeInputsReport);
  const journal = yield* Effect.serviceOption(RemoteMobileConsentJournal);
  const settings = yield* ServerSettingsService;
  const controller = Option.isSome(activation) ? yield* activation.value.status : null;
  const consent = Option.isSome(journal)
    ? yield* journal.value.read.pipe(Effect.option)
    : Option.none();
  const inputs = Option.getOrElse(report, () => ({ kind: "unsupported" as const }));
  return reply(MobileOwnerStatus, {
    authorityId,
    controller: {
      attached: controller?.attached ?? false,
      retiring: controller?.retiring ?? false,
      stopping: controller?.stopping ?? false,
      phase: controller?.controller?.phase ?? null,
      lastOutcome: controller?.controller?.lastOutcome ?? null,
      lastRepair: controller?.controller?.lastRepair ?? null,
    },
    consent: Option.isSome(consent)
      ? {
          state: consent.value.enabled ? "enabled" : "disabled",
          revision: consent.value.revision,
        }
      : { state: "unavailable", revision: null },
    inputs: { state: inputs.kind, reason: inputs.kind === "invalid" ? inputs.reason : null },
    settingsEnabled: (yield* settings.getSettings).mobileRemoteControl.enabled,
  });
});

/**
 * Owner-only mobile control (decision D-B). The enclosing client router authenticates the private
 * bearer token and RPC revision; the body must name this backend's authority. Durable consent is
 * granted only here, with the explicit confirmation literal and a revision CAS.
 */
export const mobileOwnerActivationRoute = HttpRouter.add(
  "POST",
  MOBILE_OWNER_ACTIVATION_PATH,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.mode !== "remote") return refuse("unavailable");
    const input = yield* readMobileOwnerJson(
      MOBILE_OWNER_ACTIVATION_MAX_BYTES,
      decodeMobileOwnerActivationRequest,
    );
    if (!input) return refuse("invalid-request");
    const identity = yield* RemoteBackendIdentityService;
    if (input.authorityId !== identity.authority.authorityId) return refuse("authority-mismatch");
    switch (input.action) {
      case "status":
        return yield* status(input.authorityId);
      case "consent-enable": {
        const journal = yield* Effect.serviceOption(RemoteMobileConsentJournal);
        if (Option.isNone(journal)) return refuse("unavailable");
        return yield* journal.value.enable(input.expectedRevision).pipe(
          Effect.map((result) => reply(MobileOwnerConsentResult, { ...result, enabled: true })),
          Effect.catch((error) =>
            Effect.succeed(
              refuse(
                error.code === "stale"
                  ? "stale-revision"
                  : error.code === "not-installed"
                    ? "not-installed"
                    : "unavailable",
              ),
            ),
          ),
        );
      }
      case "activate": {
        const activation = yield* Effect.serviceOption(RemoteMobileGatewayActivation);
        if (Option.isNone(activation)) return refuse("unavailable");
        return yield* activation.value
          .activate({ requestId: input.requestId, configuration: input.configuration })
          .pipe(
            Effect.map((ack) => reply(MobileOwnerActivateResult, ack)),
            Effect.catch(() => Effect.succeed(refuse("uncertain"))),
          );
      }
      case "stop": {
        const activation = yield* Effect.serviceOption(RemoteMobileGatewayActivation);
        if (Option.isNone(activation)) return refuse("unavailable");
        return yield* activation.value.stop.pipe(
          Effect.as(reply(MobileOwnerStopResult, { stopped: true })),
          Effect.catch(() => Effect.succeed(refuse("uncertain"))),
        );
      }
      case "repair": {
        const activation = yield* Effect.serviceOption(RemoteMobileGatewayActivation);
        if (Option.isNone(activation)) return refuse("unavailable");
        return yield* activation.value.repair.pipe(
          Effect.map((report) =>
            report ? reply(MobileOwnerRepairResult, report) : refuse("unavailable"),
          ),
          Effect.catch(() => Effect.succeed(refuse("uncertain"))),
        );
      }
    }
  }).pipe(Effect.catchCause(() => Effect.succeed(refuse("unavailable")))),
);
