import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";
import { V2ConsentAuthority } from "../provider/Layers/OpencodeV2/Application.consent.ts";

const config = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "v2-settings-boundary-" }),
);

it.layer(NodeServices.layer)("V2 settings persistence boundaries", (it) => {
  it.effect(
    "native trust is never inferred, explicit export/import survives, and accepted disk writes revoke before acknowledgement",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            providers: { opencodeV2: { enabled: true, connectionMode: "shared" } },
          }),
        );
        const exported = yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.equal(
              settings.currentSnapshot?.()?.settings.providers.opencodeV2.nativeServiceTrust,
              undefined,
            );
            yield* settings.updateSettings({
              providers: { opencodeV2: { nativeServiceTrust: "host-user-v1" } },
            });
            return yield* fs.readFileString(settingsPath);
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        assert.equal(JSON.parse(exported).providers.opencodeV2.nativeServiceTrust, "host-user-v1");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            const authority = new V2ConsentAuthority(settings);
            const permit = authority.capture();
            let acknowledged = false;
            const accepted: boolean[] = [];
            const unsubscribe = settings.onSnapshotChange?.(() =>
              accepted.push(!acknowledged && permit.signal.aborted),
            );
            try {
              yield* settings.updateSettings({
                providers: { opencodeV2: { nativeServiceTrust: null } },
              });
              acknowledged = true;
              assert.deepEqual(accepted, [true]);
              assert.equal(
                settings.currentSnapshot?.()?.settings.providers.opencodeV2.nativeServiceTrust,
                null,
              );
              assert.equal(
                JSON.parse(yield* fs.readFileString(settingsPath)).providers.opencodeV2
                  .nativeServiceTrust,
                null,
              );
              yield* settings.updateSettings({ greetingName: "independent" });
              assert.equal(
                (yield* settings.getSettings).providers.opencodeV2.nativeServiceTrust,
                null,
              );
            } finally {
              unsubscribe?.();
              permit.release();
              authority.close();
            }
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
      }).pipe(Effect.provide(config)),
  );
  it.effect("malformed V2 entries retain explicit consent through disk recovery and reload", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settingsPath } = yield* ServerConfig;
      for (const enabled of [false, undefined, true]) {
        const raw = JSON.stringify({
          providers: {
            opencodeV2: { enabled, binaryPath: 42 },
            opencode: { binaryPath: "/historical" },
            codex: { enabled: false },
          },
        });
        yield* fs.writeFileString(settingsPath, raw);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            const loaded = yield* settings.getSettings;
            assert.equal(loaded.providers.opencodeV2.enabled, enabled === true);
            assert.equal(loaded.providers.opencode.enabled, false);
            assert.equal(loaded.providers.opencode.binaryPath, "/historical");
            assert.equal(loaded.providers.codex.enabled, false);
            assert.equal(yield* fs.readFileString(settingsPath), raw);
            yield* settings.updateSettings({ enableThinkingStreaming: false });
            assert.equal(
              JSON.parse(yield* fs.readFileString(settingsPath)).providers.opencodeV2.enabled,
              enabled === true,
            );
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.equal(
              (yield* settings.getSettings).providers.opencodeV2.enabled,
              enabled === true,
            );
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
      }
    }).pipe(Effect.provide(config)),
  );
  it.effect(
    "fresh enable survives an unrelated write and reload; corrupt existing settings fail closed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        yield* fs.remove(settingsPath, { force: true });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.equal((yield* settings.getSettings).providers.opencodeV2.enabled, true);
            yield* settings.updateSettings({ enableThinkingStreaming: false });
            assert.equal(
              JSON.parse(yield* fs.readFileString(settingsPath)).providers.opencodeV2.enabled,
              true,
            );
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.equal((yield* settings.getSettings).providers.opencodeV2.enabled, true);
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        yield* fs.writeFileString(settingsPath, "{broken");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.equal((yield* settings.getSettings).providers.opencodeV2.enabled, false);
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
      }).pipe(Effect.provide(config)),
  );
  it.effect(
    "imports old JSON default-off and exports/reloads independent V2 paths without changing V1/Kilo",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        const legacy = {
          providers: { opencode: { binaryPath: "/v1" }, kilocode: { binaryPath: "/kilo" } },
        };
        yield* fs.writeFileString(settingsPath, JSON.stringify(legacy));
        const exported = yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.deepEqual((yield* settings.getSettings).providers.opencodeV2, {
              enabled: false,
              binaryPath: "",
              profileRoot: "",
            });
            yield* settings.updateSettings({
              providers: {
                opencodeV2: { enabled: true, binaryPath: "/separate/v2", profileRoot: "/owned/v2" },
              },
            });
            return yield* fs.readFileString(settingsPath);
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        // Import the actual sparse export, not a schema/helper reconstruction.
        yield* fs.writeFileString(settingsPath, exported);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            const read = yield* settings.getSettings;
            assert.equal(read.providers.opencode.binaryPath, "/v1");
            assert.equal(read.providers.kilocode.binaryPath, "/kilo");
            assert.deepEqual(read.providers.opencodeV2, {
              enabled: true,
              binaryPath: "/separate/v2",
              profileRoot: "/owned/v2",
            });
            yield* settings.updateSettings({ providers: { opencodeV2: { enabled: false } } });
            const disabled = JSON.parse(yield* fs.readFileString(settingsPath));
            assert.equal(disabled.providers.opencodeV2.enabled, false); // Explicit disable, not erased paths.
            assert.equal(disabled.providers.opencodeV2.binaryPath, "/separate/v2");
            assert.equal(disabled.providers.opencode.binaryPath, "/v1");
            assert.equal(disabled.providers.kilocode.binaryPath, "/kilo");
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
      }).pipe(Effect.provide(config)),
  );

  it.effect(
    "partial recovery and unrelated writes retain historical selections and independent provider configuration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        const selection = {
          provider: "opencodeV2" as const,
          model: "native",
          subProviderID: "fixture",
          options: { variant: "precise" },
        };
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            textGenerationModelSelection: selection,
            defaultChatCwd: 42, // Force the real tolerant rollback-reader path.
            providers: {
              opencode: { binaryPath: "/v1" },
              kilocode: { binaryPath: "/kilo" },
              opencodeV2: { enabled: true, binaryPath: "/v2", profileRoot: "/owned" },
            },
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            assert.deepEqual((yield* settings.getSettings).textGenerationModelSelection, selection);
            yield* settings.updateSettings({
              defaultChatCwd: "/workspace",
              providers: { opencodeV2: { enabled: false } },
            });
            const raw = JSON.parse(yield* fs.readFileString(settingsPath));
            assert.deepEqual(raw.textGenerationModelSelection, selection);
            assert.equal(raw.providers.opencode.binaryPath, "/v1");
            assert.equal(raw.providers.kilocode.binaryPath, "/kilo");
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            yield* settings.start;
            yield* settings.updateSettings({ providers: { opencodeV2: { enabled: true } } });
            assert.deepEqual((yield* settings.getSettings).textGenerationModelSelection, selection);
          }).pipe(Effect.provide(ServerSettingsLive)),
        );
      }).pipe(Effect.provide(config)),
  );
});
