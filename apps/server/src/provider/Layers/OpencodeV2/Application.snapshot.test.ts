import { Effect, Stream } from "effect";
import { expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsError } from "@bigbud/contracts";

import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";

const disabledSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: false },
  },
};

it("reads the application snapshot without publishing a provider change", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const [registration] = yield* composeOptionalProviders([], {});
        const updates: unknown[] = [];
        yield* registration!.providerService.streamChanges.pipe(
          Stream.take(3),
          Stream.runForEach((snapshot) => Effect.sync(() => updates.push(snapshot))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("10 millis");
        for (let index = 0; index < 3; index++) {
          const snapshot = yield* registration!.providerService.getSnapshot;
          expect(snapshot).toMatchObject({ provider: "opencodeV2", enabled: false });
        }
        yield* Effect.sleep("10 millis");
        expect(updates).toEqual([]);
      }),
    ).pipe(
      Effect.provide(ServerSettingsService.layerTest(disabledSettings)),
      Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
    ),
  );
});

it("keeps optional provider construction nonblocking when settings cannot be read", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const [registration] = yield* composeOptionalProviders([], {}).pipe(
          Effect.provideService(ServerSettingsService, {
            ...settings,
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "/unavailable", detail: "Read failed." }),
            ),
            streamChanges: Stream.never,
          }),
        );
        expect(yield* registration!.providerService.getSnapshot).toMatchObject({
          enabled: false,
          message: "V2 settings are unavailable.",
        });
      }),
    ).pipe(
      Effect.provide(ServerSettingsService.layerTest()),
      Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
    ),
  );
});

it("does not refresh again when a registry listener reads a configuration failure", async () => {
  let current = disabledSettings;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const [registration] = yield* composeOptionalProviders([], {}).pipe(
          Effect.provideService(ServerSettingsService, {
            ...settings,
            getSettings: Effect.sync(() => current),
            streamChanges: Stream.never,
          }),
        );
        const updates: unknown[] = [];
        yield* registration!.providerService.streamChanges.pipe(
          Stream.take(3),
          Stream.runForEach((snapshot) =>
            registration!.providerService.getSnapshot.pipe(
              Effect.tap((cached) => {
                expect(cached).toEqual(snapshot);
                updates.push(cached);
                return Effect.void;
              }),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Effect.sleep("10 millis");
        current = {
          ...current,
          providers: {
            ...current.providers,
            opencodeV2: {
              ...current.providers.opencodeV2,
              enabled: true,
              connectionMode: "isolated",
            },
          },
        };
        const snapshot = yield* registration!.providerService.refresh;
        expect(snapshot).toMatchObject({ enabled: true, installed: false, status: "warning" });
        yield* Effect.sleep("20 millis");
        expect(updates).toEqual([snapshot]);
      }),
    ).pipe(
      Effect.provide(ServerSettingsService.layerTest()),
      Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
    ),
  );
});
