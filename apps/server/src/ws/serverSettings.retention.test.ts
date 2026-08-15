import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";

const makeLayer = (prefix: string) => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    NodeServices.layer,
    config,
    ServerSettingsLive.pipe(Layer.provide(config), Layer.provide(NodeServices.layer)),
  );
};

it.effect("quarantines a live finite disk edit without adopting it", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    if (!settings.setThreadRetentionPolicy) return yield* Effect.die("retention unavailable");
    yield* settings.setThreadRetentionPolicy("never");
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ threadRetentionPolicy: "7-days" }),
    );
    const current = yield* settings.updateSettings({ defaultChatCwd: "/workspace" });
    assert.equal(current.threadRetentionPolicy, "never");
    assert.notEqual(
      JSON.parse(yield* fs.readFileString(config.settingsPath)).threadRetentionPolicy,
      "7-days",
    );
  }).pipe(Effect.provide(makeLayer("bigbud-retention-live-edit-"))),
);

it.effect("fails malformed raw retention values safe while retaining valid settings", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    if (!settings.setThreadRetentionPolicy) return yield* Effect.die("retention unavailable");
    yield* settings.setThreadRetentionPolicy("never");
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ defaultChatCwd: "/workspace", threadRetentionPolicy: "tomorrow" }),
    );
    yield* settings.start;

    const current = yield* settings.getSettings;
    assert.equal(current.threadRetentionPolicy, "never");
    assert.equal(current.defaultChatCwd, "/workspace");
    const persisted = JSON.parse(yield* fs.readFileString(config.settingsPath));
    assert.equal(persisted.threadRetentionPolicy, "never");
    assert.equal(persisted.defaultChatCwd, "/workspace");
  }).pipe(Effect.provide(makeLayer("bigbud-retention-malformed-"))),
);

it.effect("persists an explicitly authorized finite transition", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    if (!settings.setThreadRetentionPolicy) return yield* Effect.die("retention unavailable");
    const updated = yield* settings.setThreadRetentionPolicy("7-days");

    assert.equal(updated.threadRetentionPolicy, "7-days");
    assert.equal(
      JSON.parse(yield* fs.readFileString(config.settingsPath)).threadRetentionPolicy,
      "7-days",
    );
  }).pipe(Effect.provide(makeLayer("bigbud-retention-explicit-"))),
);

it.effect("ignores forged settings and legacy sidecar authority after restart", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      if (!settings.setThreadRetentionPolicy) return yield* Effect.die("retention unavailable");
      yield* settings.setThreadRetentionPolicy("14-days");
    }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));

    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ threadRetentionPolicy: "90-days" }),
    );
    yield* fs.writeFileString(
      `${config.settingsPath}.retention-authority.json`,
      JSON.stringify({ version: 1, policy: "90-days", source: "explicit" }),
    );
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.start;
      assert.equal((yield* settings.getSettings).threadRetentionPolicy, "never");
      assert.equal(
        JSON.parse(yield* fs.readFileString(config.settingsPath)).threadRetentionPolicy,
        "never",
      );
    }).pipe(Effect.provide(Layer.fresh(ServerSettingsLive)));
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-retention-restart-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  ),
);
