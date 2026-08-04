import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ServerSettingsLive, ServerSettingsService } from "../ws/serverSettings.ts";
import { ServerConfig } from "./config.ts";
import { runThreadRetentionSettingsMigration } from "./ThreadRetentionSettingsMigration.ts";

const automaticRolloutFlag = "BIGBUD_INTERNAL_THREAD_RETENTION_AUTOMATIC_ROLLOUT";

const withAutomaticRollout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.env[automaticRolloutFlag]),
    () => Effect.sync(() => (process.env[automaticRolloutFlag] = "1")).pipe(Effect.andThen(effect)),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[automaticRolloutFlag];
        else process.env[automaticRolloutFlag] = previous;
      }),
  );

const withoutAutomaticRollout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => process.env[automaticRolloutFlag]),
    () => Effect.sync(() => delete process.env[automaticRolloutFlag]).pipe(Effect.andThen(effect)),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[automaticRolloutFlag];
        else process.env[automaticRolloutFlag] = previous;
      }),
  );

const makeLayer = (prefix: string) => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    NodeServices.layer,
    SqlitePersistenceMemory,
    config,
    ServerSettingsLive.pipe(Layer.provide(config), Layer.provide(NodeServices.layer)),
  );
};

const makePersistentLayer = (baseDir: string) => {
  const config = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Layer.mergeAll(
    NodeServices.layer,
    SqlitePersistenceMemory,
    config,
    ServerSettingsLive.pipe(Layer.provide(config), Layer.provide(NodeServices.layer)),
  );
};

it.effect("defaults data-empty rollout to 7 days when the staged rollout is enabled", () =>
  withAutomaticRollout(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE thread_retention_rollout SET had_user_threads = 0 WHERE singleton_id = 1`;
      yield* runThreadRetentionSettingsMigration();
      const settings = yield* ServerSettingsService;
      assert.equal((yield* settings.getSettings).threadRetentionPolicy, "7-days");
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      assert.equal(
        JSON.parse(yield* fs.readFileString(config.settingsPath)).threadRetentionPolicy,
        "7-days",
      );
      const authority = yield* sql<{ source: string }>`
        SELECT source FROM thread_retention_policy_authority WHERE singleton_id = 1
      `;
      assert.equal(authority[0]?.source, "rollout-automatic");
    }).pipe(Effect.provide(makeLayer("bigbud-retention-rollout-empty-"))),
  ),
);

it.effect("protects upgraded installs from a pre-start finite disk policy", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    yield* sql`UPDATE thread_retention_rollout SET had_user_threads = 1 WHERE singleton_id = 1`;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ threadRetentionPolicy: "30-days" }),
    );
    yield* runThreadRetentionSettingsMigration();
    assert.equal(
      JSON.parse(yield* fs.readFileString(config.settingsPath)).threadRetentionPolicy,
      "never",
    );
    const authority = yield* sql<{ source: string }>`
      SELECT source FROM thread_retention_policy_authority WHERE singleton_id = 1
    `;
    assert.equal(authority[0]?.source, "rollout-protected");
  }).pipe(Effect.provide(makeLayer("bigbud-retention-rollout-existing-"))),
);

it.effect("defaults a data-empty install to 7 days without a rollout flag", () =>
  withoutAutomaticRollout(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE thread_retention_rollout SET had_user_threads = 0 WHERE singleton_id = 1`;
      yield* runThreadRetentionSettingsMigration();
      const settings = yield* ServerSettingsService;
      assert.equal((yield* settings.getSettings).threadRetentionPolicy, "7-days");
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      assert.equal(
        JSON.parse(yield* fs.readFileString(config.settingsPath)).threadRetentionPolicy,
        "7-days",
      );
      const authority = yield* sql<{ source: string }>`
        SELECT source FROM thread_retention_policy_authority WHERE singleton_id = 1
      `;
      assert.equal(authority[0]?.source, "rollout-automatic");
    }).pipe(Effect.provide(makeLayer("bigbud-retention-rollout-staged-"))),
  ),
);

it.effect("preserves staged automatic rollout across a full settings restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-retention-restart-" });
      yield* withAutomaticRollout(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE thread_retention_rollout SET had_user_threads = 0 WHERE singleton_id = 1`;
          yield* runThreadRetentionSettingsMigration();
        }).pipe(Effect.provide(makePersistentLayer(baseDir))),
      );

      delete process.env[automaticRolloutFlag];
      const policy = yield* Effect.gen(function* () {
        yield* runThreadRetentionSettingsMigration();
        const settings = yield* ServerSettingsService;
        return (yield* settings.getSettings).threadRetentionPolicy;
      }).pipe(Effect.provide(makePersistentLayer(baseDir)));
      assert.equal(policy, "7-days");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
