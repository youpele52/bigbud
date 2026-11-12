import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";
import {
  decodeSettingsFieldWise,
  stripDefaultServerSettings,
} from "./serverSettings.persistence.ts";
import { runTerminalShellSettingsMigration } from "../startup/serverRuntimeStartup.terminalShells.ts";

const layer = ServerSettingsLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-shell-settings-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("fresh Windows choice is durable and later inventory does not reinterpret it", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    yield* runTerminalShellSettingsMigration({
      platform: "win32",
      evidence: "fresh",
      discoverFreshWindowsSelection: Effect.succeed({
        kind: "profile",
        profileId: "local:windows-powershell",
      }),
    });
    yield* runTerminalShellSettingsMigration({
      platform: "win32",
      evidence: "fresh",
      discoverFreshWindowsSelection: Effect.die("must not rediscover after migration"),
    });
    expect((yield* settings.getSettings).terminalShells.hostDefaults.local).toEqual({
      kind: "profile",
      profileId: "local:windows-powershell",
    });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("inventory preserves concurrent policy and unrelated settings writes", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const migration = yield* Effect.forkChild(
      runTerminalShellSettingsMigration({
        platform: "win32",
        evidence: "fresh",
        discoverFreshWindowsSelection: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ kind: "profile" as const, profileId: "local:pwsh" }),
        ),
      }),
    );
    yield* Deferred.await(entered);
    yield* settings.updateSettings({
      defaultChatCwd: "/new-cwd",
      terminalShells: { suggestionPolicy: "qualified-history" },
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(migration);
    const next = yield* settings.getSettings;
    expect(next.defaultChatCwd).toBe("/new-cwd");
    expect(next.terminalShells.suggestionPolicy).toBe("qualified-history");
    expect(next.terminalShells.origin).toBe("fresh");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("version zero recognizable choices survive conservative initialization", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        terminalShells: {
          version: 0,
          origin: "uninitialized",
          suggestionPolicy: "off",
          hostDefaults: { local: { kind: "profile", profileId: "local:pwsh" } },
        },
      }),
    );
    yield* settings.start;
    yield* runTerminalShellSettingsMigration({ platform: "linux" });
    expect((yield* settings.getSettings).terminalShells.origin).toBe("explicit");
    expect((yield* settings.getSettings).terminalShells.hostDefaults.local).toEqual({
      kind: "profile",
      profileId: "local:pwsh",
    });
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("persists an atomic marker and reloads the same choice after restart", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* settings.start;
    yield* runTerminalShellSettingsMigration({ platform: "linux", evidence: "fresh" });
    const current = yield* settings.getSettings;
    expect(current.terminalShells).toEqual({
      version: 1,
      origin: "fresh",
      hostDefaults: { local: { kind: "legacy-auto" } },
      suggestionPolicy: "off",
    });
    const raw = yield* fs.readFileString(config.settingsPath);
    expect(JSON.parse(raw).terminalShells).toEqual(current.terminalShells);
    expect(decodeSettingsFieldWise(raw)?.terminalShells).toEqual(current.terminalShells);
    const restarted = yield* Effect.service(ServerSettingsService).pipe(
      Effect.provide(ServerSettingsLive),
    );
    yield* restarted.start;
    expect((yield* restarted.getSettings).terminalShells).toEqual(current.terminalShells);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("replaces host records and selections; policy-only updates do not initialize", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    yield* settings.updateSettings({ terminalShells: { suggestionPolicy: "qualified-history" } });
    expect((yield* settings.getSettings).terminalShells.version).toBe(0);
    yield* settings.updateSettings({
      terminalShells: {
        hostDefaults: {
          local: { kind: "profile", profileId: "local:pwsh" },
          other: { kind: "legacy-auto" },
        },
      },
    });
    const next = yield* settings.updateSettings({
      terminalShells: { hostDefaults: { local: { kind: "legacy-auto" } } },
    });
    expect(next.terminalShells).toEqual({
      version: 1,
      origin: "explicit",
      hostDefaults: { local: { kind: "legacy-auto" } },
      suggestionPolicy: "qualified-history",
    });
    yield* runTerminalShellSettingsMigration({ platform: "win32", evidence: "fresh" });
    expect((yield* settings.getSettings).terminalShells).toEqual(next.terminalShells);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "rechecks current settings after inventory and preserves concurrent user choices and policy",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.start;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const migration = yield* Effect.forkChild(
        runTerminalShellSettingsMigration({
          platform: "win32",
          evidence: "fresh",
          discoverFreshWindowsSelection: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ kind: "profile" as const, profileId: "local:pwsh" }),
          ),
        }),
      );
      yield* Deferred.await(entered);
      const explicit = yield* settings.updateSettings({
        terminalShells: {
          hostDefaults: { local: { kind: "profile", profileId: "local:cmd" } },
          suggestionPolicy: "qualified-history",
        },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(migration);
      expect((yield* settings.getSettings).terminalShells).toEqual(explicit.terminalShells);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "failed migration writes do not publish or accept an undurable choice and can retry",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* settings.start;
      const before = settings.currentSnapshot!();
      // A directory cannot be replaced by the atomic file rename.
      yield* fs.makeDirectory(config.settingsPath);
      yield* runTerminalShellSettingsMigration({
        platform: "win32",
        evidence: "fresh",
        discoverFreshWindowsSelection: Effect.succeed({ kind: "profile", profileId: "local:pwsh" }),
      });
      expect(settings.currentSnapshot!()).toBe(before);
      expect((yield* settings.getSettings).terminalShells.version).toBe(0);
      yield* fs.remove(config.settingsPath, { recursive: true });
      yield* runTerminalShellSettingsMigration({
        platform: "linux",
        evidence: "existing-or-uncertain",
      });
      expect((yield* settings.getSettings).terminalShells.origin).toBe("existing-or-uncertain");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

for (const inventory of [undefined, Effect.fail("inventory failed"), Effect.succeed(undefined)]) {
  it.effect("fresh Windows without reliable inventory remains uninitialized", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* settings.start;
      yield* runTerminalShellSettingsMigration({
        platform: "win32",
        evidence: "fresh",
        ...(inventory ? { discoverFreshWindowsSelection: inventory } : {}),
      });
      expect((yield* settings.getSettings).terminalShells.version).toBe(0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

for (const raw of [undefined, "broken json", "{}", '{"terminalShells":{"version":99}}']) {
  it.effect(
    "absent or damaged settings without freshness evidence keep Windows compatibility",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        if (raw !== undefined) yield* fs.writeFileString(config.settingsPath, raw);
        yield* settings.start;
        yield* runTerminalShellSettingsMigration({ platform: "win32" });
        expect((yield* settings.getSettings).terminalShells).toEqual({
          version: 1,
          origin: "existing-or-uncertain",
          hostDefaults: { local: { kind: "legacy-auto" } },
          suggestionPolicy: "off",
        });
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

it.effect("sparse persistence and partial recovery retain recognizable shell choices", () =>
  Effect.sync(() => {
    const terminalShells = {
      version: 1,
      origin: "explicit",
      hostDefaults: { local: { kind: "profile", profileId: "local:pwsh" } },
      suggestionPolicy: "off",
    };
    const sparse = stripDefaultServerSettings(
      { ...DEFAULT_SERVER_SETTINGS, terminalShells },
      DEFAULT_SERVER_SETTINGS,
    ) as Record<string, unknown>;
    expect(sparse.terminalShells).toEqual(terminalShells);
    const recovered = decodeSettingsFieldWise(
      JSON.stringify({
        terminalShells: {
          ...terminalShells,
          suggestionPolicy: "broken",
          hostDefaults: { ...terminalShells.hostDefaults, bad: { kind: "nope" } },
        },
        defaultChatCwd: 42,
      }),
    );
    expect(recovered?.terminalShells).toEqual(terminalShells);
  }),
);
