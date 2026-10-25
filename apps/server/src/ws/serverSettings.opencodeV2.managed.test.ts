import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";
import { V2ConsentAuthority } from "../provider/Layers/OpencodeV2/Application.consent.ts";
import { v2ApplicationConfigKey } from "../provider/Layers/OpencodeV2/Application.configKey.ts";

const config = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "v2-managed-settings-" }),
);
it.layer(NodeServices.layer)("managed plugin scope persistence", (it) => {
  it.effect(
    "expanded ack/root export/import/clear preserves cwd/providers and fences before accepted changes without changing connection identity",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            defaultChatCwd: "/actual-chat",
            providers: {
              codex: { enabled: false },
              opencodeV2: { nativeServiceTrust: "host-user-v1" },
            },
          }),
        );
        const exported = yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            const before = yield* settings.getSettings;
            yield* settings.updateSettings({
              providers: {
                opencodeV2: {
                  enabled: true,
                  nativeServiceTrust: "managed-thread-tools-v2",
                  nativePluginConfigRoot: " /native/config ",
                },
              },
            });
            const changed = yield* settings.getSettings;
            assert.equal(changed.defaultChatCwd, before.defaultChatCwd);
            assert.deepEqual(changed.providers.codex, before.providers.codex);
            assert.equal(changed.providers.opencodeV2.nativePluginConfigRoot, "/native/config");
            return yield* fs.readFileString(settingsPath);
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        assert.equal(
          JSON.parse(exported).providers.opencodeV2.nativeServiceTrust,
          "managed-thread-tools-v2",
        );
        yield* fs.writeFileString(settingsPath, exported);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            const loaded = yield* settings.getSettings;
            assert.equal(loaded.providers.opencodeV2.nativePluginConfigRoot, "/native/config");
            const authority = new V2ConsentAuthority(settings);
            const permit = authority.capture();
            let accepted = false;
            const unsubscribe = settings.onSnapshotChange?.(() => {
              assert.equal(permit.signal.aborted, true);
              assert.equal(accepted, false);
            });
            try {
              yield* settings.updateSettings({
                providers: { opencodeV2: { nativePluginConfigRoot: "" } },
              });
              accepted = true;
              const after = yield* settings.getSettings;
              assert.equal(after.providers.opencodeV2.nativePluginConfigRoot, "");
              assert.equal(
                after.providers.opencodeV2.nativeServiceTrust,
                "managed-thread-tools-v2",
              );
              assert.equal(
                v2ApplicationConfigKey(after.providers.opencodeV2),
                v2ApplicationConfigKey(loaded.providers.opencodeV2),
              );
              assert.equal(after.defaultChatCwd, "/actual-chat");
            } finally {
              unsubscribe?.();
              permit.release();
              authority.close();
            }
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
      }).pipe(Effect.provide(config)),
  );
});
