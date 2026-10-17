import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../startup/config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

it.layer(NodeServices.layer)("shared greeting name persistence", (it) => {
  it.effect("persists a trimmed nickname, reloads on restart, and can clear it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const named = yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        assert.strictEqual((yield* settings.getSettings).greetingName, "");
        return yield* settings.updateSettings({ greetingName: "  小雨 Youpele  " });
      }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
      assert.strictEqual(named.greetingName, "小雨 Youpele");
      const saved = JSON.parse(yield* fs.readFileString(config.settingsPath));
      assert.strictEqual(saved.greetingName, "小雨 Youpele");

      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        assert.strictEqual((yield* settings.getSettings).greetingName, "小雨 Youpele");
        const unrelated = yield* settings.updateSettings({ enableAssistantStreaming: false });
        assert.strictEqual(unrelated.greetingName, "小雨 Youpele");
        const cleared = yield* settings.updateSettings({ greetingName: "   " });
        assert.strictEqual(cleared.greetingName, "");
      }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));

      const clearedDisk = JSON.parse(yield* fs.readFileString(config.settingsPath));
      assert.isUndefined(clearedDisk.greetingName);
      yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        assert.strictEqual((yield* settings.getSettings).greetingName, "");
        assert.strictEqual((yield* settings.getSettings).enableAssistantStreaming, false);
      }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-greeting-test-" })),
    ),
  );

  it.effect("rejects an oversized nickname without changing the saved setting", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ greetingName: "Youpele" });
      const result = yield* settings
        .updateSettings({ greetingName: "a".repeat(65) })
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual((yield* settings.getSettings).greetingName, "Youpele");
    }).pipe(
      Effect.provide(
        ServerSettingsLive.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-greeting-test-" })),
        ),
      ),
    ),
  );
});
