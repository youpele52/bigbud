import { chmod, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Effect, PubSub, Stream } from "effect";
import { expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@bigbud/contracts";
import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("registers V2 without env flags, honors settings edits, and rejects missing/incompatible binaries independently of V1", async () => {
  await withV2RuntimeFixture(async ({ runtime }) => {
    const parent = await realpath(runtime.options.config.profileRoot);
    const incompatible = path.join(parent, "incompatible");
    await writeFile(incompatible, "#!/bin/sh\necho 1.99.0\n", { mode: 0o700 });
    await chmod(incompatible, 0o700);
    for (const binaryPath of [path.join(parent, "missing"), incompatible]) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const settings = yield* ServerSettingsService;
            const registrations = yield* composeOptionalProviders([], {});
            const registration = registrations[0]!;
            expect(registration.capabilities.needsBuiltinsDisabled).toBe(true);
            expect(registration.capabilities.supportsRemoteProviderRuntime).toBe(true);
            expect(registration.capabilities.supportsLocalRuntimeRemoteWorkspace).toBe(true);
            const disabled = yield* registration.providerService.getSnapshot;
            expect(disabled).toMatchObject({ provider: "opencodeV2", enabled: false, models: [] });
            expect(disabled.developmentOnly).toBeUndefined();
            yield* settings.updateSettings({
              providers: {
                opencodeV2: {
                  enabled: true,
                  binaryPath,
                  profileRoot: path.join(
                    parent,
                    binaryPath === incompatible ? "profile2" : "profile1",
                  ),
                },
              },
            });
            const snapshot = yield* registration.providerService.refresh;
            expect(snapshot).toMatchObject({
              enabled: true,
              installed: false,
              status: "warning",
              models: [],
            });
            expect(snapshot.message).toContain("2.0.19");
            const started = yield* registration.adapterService
              .startSession({
                threadId: ThreadId.makeUnsafe("not-ready"),
                cwd: parent,
                runtimeMode: "approval-required",
                modelSelection: {
                  provider: "opencodeV2",
                  subProviderID: "fixture",
                  model: "fixture",
                },
              })
              .pipe(Effect.result);
            expect(started._tag).toBe("Failure");
            expect((yield* settings.getSettings).providers.opencode).toEqual(
              DEFAULT_SERVER_SETTINGS.providers.opencode,
            );
            yield* settings.updateSettings({
              providers: { opencodeV2: { binaryPath: "/another/v2" } },
            });
            expect((yield* registration.providerService.refresh).message).toContain(
              "Restart bigbud",
            );
            yield* settings.updateSettings({ providers: { opencodeV2: { enabled: false } } });
            expect((yield* registration.providerService.refresh).enabled).toBe(false);
          }),
        ).pipe(
          Effect.provide(ServerSettingsService.layerTest()),
          Effect.provideService(ProviderTurnAdmissions, runtime.options.journal),
        ),
      );
    }
  });
});

it("publishes readiness changes when saved V2 settings change without manual refresh", async () => {
  await withV2RuntimeFixture(async ({ runtime }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const settingsChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
          let current = DEFAULT_SERVER_SETTINGS;
          const registrations = yield* composeOptionalProviders([], {}).pipe(
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.sync(() => current),
              streamChanges: Stream.fromPubSub(settingsChanges),
            } as unknown as typeof ServerSettingsService.Service),
          );
          const enabled: boolean[] = [];
          yield* registrations[0]!.providerService.streamChanges.pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => {
                enabled.push(value.enabled);
              }),
            ),
            Effect.forkScoped,
          );
          yield* Effect.sleep("10 millis");
          current = {
            ...current,
            providers: {
              ...current.providers,
              opencodeV2: {
                enabled: true,
                binaryPath: "",
                profileRoot: "",
              },
            },
          };
          yield* PubSub.publish(settingsChanges, current);
          yield* Effect.promise(() => expect.poll(() => enabled).toEqual([true]));
          current = DEFAULT_SERVER_SETTINGS;
          yield* PubSub.publish(settingsChanges, current);
          yield* Effect.promise(() => expect.poll(() => enabled).toEqual([true, false]));
        }),
      ).pipe(Effect.provideService(ProviderTurnAdmissions, runtime.options.journal)),
    );
  });
});
