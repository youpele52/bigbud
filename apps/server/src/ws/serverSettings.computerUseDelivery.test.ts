import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../startup/config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

it.layer(NodeServices.layer)("Computer Use delivery persistence", (it) => {
  it.effect(
    "defaults existing settings to background and preserves the user's foreground choice across restarts",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ computerUseEnabled: true }),
        );
        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          assert.strictEqual((yield* settings.getSettings).computerUseDeliveryMode, "background");
          yield* settings.updateSettings({ computerUseDeliveryMode: "foreground" });
        }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
        assert.strictEqual(
          JSON.parse(yield* fs.readFileString(config.settingsPath)).computerUseDeliveryMode,
          "foreground",
        );
        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          assert.strictEqual((yield* settings.getSettings).computerUseDeliveryMode, "foreground");
          yield* settings.updateSettings({ computerUseDeliveryMode: "background" });
        }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          assert.strictEqual((yield* settings.getSettings).computerUseDeliveryMode, "background");
          assert.strictEqual((yield* settings.getSettings).computerUseEnabled, true);
        }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-delivery-test-" })),
      ),
  );
});
