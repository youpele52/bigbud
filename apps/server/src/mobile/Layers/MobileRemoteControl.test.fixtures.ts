import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@bigbud/contracts/settings";
import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

import { buildTestServerConfig } from "../../server.test.app.config.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { MobileRemoteControl } from "../Services/MobileRemoteControl.ts";
import { MobileRemoteControlLive } from "./MobileRemoteControl.ts";

const settingsWith = (enabled: boolean): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  mobileRemoteControl: { ...DEFAULT_SERVER_SETTINGS.mobileRemoteControl, enabled },
});

/** Test-only handle that flips mobile remote control, optionally announcing it. */
export class MobileSetting extends ServiceMap.Service<
  MobileSetting,
  {
    readonly set: (
      enabled: boolean,
      options: { readonly announce: boolean },
    ) => Effect.Effect<void>;
  }
>()("test/MobileSetting") {}

const settingsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* Ref.make(true);
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const set = (next: boolean, options: { readonly announce: boolean }) =>
      Ref.set(enabled, next).pipe(
        Effect.andThen(
          options.announce ? PubSub.publish(changes, settingsWith(next)) : Effect.void,
        ),
        Effect.asVoid,
      );
    return Layer.merge(
      Layer.succeed(MobileSetting, { set }),
      Layer.mock(ServerSettingsService)({
        getSettings: Ref.get(enabled).pipe(Effect.map(settingsWith)),
        streamChanges: Stream.fromPubSub(changes),
      }),
    );
  }),
);

/** The real file-backed layer over temporary state, with a toggleable setting. */
export const mobileLayer = MobileRemoteControlLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Layer.effect(ServerConfig, buildTestServerConfig()), settingsLayer),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** Creates and exchanges one pairing, returning the resulting session. */
export const pairedSession = Effect.gen(function* () {
  const mobile = yield* MobileRemoteControl;
  const pairing = yield* mobile.createPairing({
    scope: "thread-control",
    baseUrl: "https://desk.ts.net/mobile",
    backendBaseUrl: "https://desk.ts.net",
  });
  const session = yield* mobile.exchangePairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    label: "phone",
  });
  return { mobile, pairing, session, watch: mobile.watchSessionEnd! };
});
