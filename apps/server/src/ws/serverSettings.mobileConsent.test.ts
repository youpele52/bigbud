import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import * as nodeFs from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";
import { ServerSettingsMobileConsentGuard } from "./serverSettings.mobileConsent.ts";

function settingsLayer(revoke?: Effect.Effect<void, Error>, mode: "remote" | "web" = "remote") {
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "bb-mobile-settings-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const config = Layer.effect(
    ServerConfig,
    Effect.map(Effect.service(ServerConfig), (value) => ({ ...value, mode })),
  ).pipe(Layer.provide(base));
  return ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        config,
        NodeServices.layer,
        revoke ? Layer.succeed(ServerSettingsMobileConsentGuard, { revoke }) : Layer.empty,
      ),
    ),
  );
}

it("does not publish or acknowledge settings-off until durable revocation finishes", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let hold = false;
  let durableEnabled = false;
  const revoke = Effect.gen(function* () {
    if (hold) {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
    }
    durableEnabled = false;
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        yield* settings.start;
        yield* settings.updateSettings({ mobileRemoteControl: { enabled: true } });
        expect(durableEnabled).toBe(false); // Enabling settings never grants separate CAS consent.
        durableEnabled = true;
        hold = true;
        const off = yield* Effect.forkChild(
          settings.updateSettings({ mobileRemoteControl: { enabled: false } }),
          { startImmediately: true },
        );
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
        expect(settings.currentSnapshot!()!.settings.mobileRemoteControl.enabled).toBe(true);
        expect(JSON.parse(yield* fs.readFileString(settingsPath)).mobileRemoteControl.enabled).toBe(
          true,
        );
        expect(durableEnabled).toBe(true);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(off);
        expect(durableEnabled).toBe(false);
        expect(result.mobileRemoteControl.enabled).toBe(false);
        expect(settings.currentSnapshot!()!.settings.mobileRemoteControl.enabled).toBe(false);
      }).pipe(Effect.provide(settingsLayer(revoke))),
    ),
  );
});

it("refuses settings-off when CAS revocation fails, preserving the accepted settings", async () => {
  let fail = false;
  const revoke = Effect.suspend(() =>
    fail ? Effect.fail(new Error("fixture CAS failure")) : Effect.void,
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        yield* settings.start;
        yield* settings.updateSettings({ mobileRemoteControl: { enabled: true } });
        const before = yield* fs.readFileString(settingsPath);
        fail = true;
        const result = yield* settings
          .updateSettings({ mobileRemoteControl: { enabled: false } })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(settings.currentSnapshot!()!.settings.mobileRemoteControl.enabled).toBe(true);
        expect(yield* fs.readFileString(settingsPath)).toBe(before);
        fail = false;
      }).pipe(Effect.provide(settingsLayer(revoke))),
    ),
  );
});

it("keeps durable consent off if settings persistence fails after the revoke", async () => {
  let replace: (() => Promise<void>) | undefined;
  let durableEnabled = false;
  const revoke = Effect.promise(async () => {
    durableEnabled = false;
    await replace?.();
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        yield* settings.start;
        yield* settings.updateSettings({ mobileRemoteControl: { enabled: true } });
        durableEnabled = true;
        const directory = dirname(settingsPath),
          saved = `${directory}-preserved`;
        replace = async () => {
          await nodeFs.rename(directory, saved);
          await nodeFs.writeFile(directory, "fixture prevents settings write");
        };
        yield* settings.updateSettings({ mobileRemoteControl: { enabled: false } }).pipe(
          Effect.result,
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result._tag).toBe("Failure");
              expect(durableEnabled).toBe(false);
              expect(settings.currentSnapshot!()!.settings.mobileRemoteControl.enabled).toBe(true);
            }),
          ),
          Effect.ensuring(
            Effect.promise(async () => {
              replace = undefined;
              await nodeFs.unlink(directory);
              await nodeFs.rename(saved, directory);
            }),
          ),
        );
      }).pipe(Effect.provide(settingsLayer(revoke))),
    ),
  );
});

it("fences an observed external off before accepting its snapshot", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  let hold = false;
  const revoke = Effect.gen(function* () {
    if (hold) {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
    }
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        yield* settings.start;
        yield* settings.updateSettings({ mobileRemoteControl: { enabled: true } });
        hold = true;
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({ mobileRemoteControl: { enabled: false } }),
        );
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"));
        expect(settings.currentSnapshot!()!.settings.mobileRemoteControl.enabled).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.promise(() =>
          expect
            .poll(() => settings.currentSnapshot!()!.settings.mobileRemoteControl.enabled, {
              timeout: 5000,
            })
            .toBe(false),
        );
      }).pipe(Effect.provide(settingsLayer(revoke))),
    ),
  );
});

it("requires remote revocation policy at startup and leaves web behavior compatible", async () => {
  await expect(
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* ServerSettingsService;
          yield* settings.start;
        }).pipe(Effect.provide(settingsLayer())),
      ),
    ),
  ).rejects.toThrow("durable consent");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.start;
        expect(
          (yield* settings.updateSettings({ mobileRemoteControl: { enabled: false } }))
            .mobileRemoteControl.enabled,
        ).toBe(false);
      }).pipe(Effect.provide(settingsLayer(undefined, "web"))),
    ),
  );
});
