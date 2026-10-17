import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ThreadToolsActivation } from "../../Services/OpencodeV2/ThreadToolsActivation.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";

export const ThreadToolsActivationLive = Layer.effect(
  ThreadToolsActivation,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const activation = new V2ThreadToolsActivation(settings);
    yield* Effect.addFinalizer(() => Effect.promise(() => activation.close()));
    return activation;
  }),
);
