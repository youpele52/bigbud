import { Effect, Stream } from "effect";
import { expect, it } from "vitest";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";

it("reads the development snapshot without probing or publishing a provider change", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* makeV2DevelopmentProvider({} as OpencodeV2Runtime, {
          process: { binaryPath: "/unused", profileRoot: "/unused", runtimeTargetId: "local" },
          workspace: "/unused",
        });
        const updates: unknown[] = [];
        yield* provider.streamChanges.pipe(
          Stream.take(3),
          Stream.runForEach((snapshot) => Effect.sync(() => updates.push(snapshot))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("10 millis");
        for (let index = 0; index < 3; index++) {
          expect(yield* provider.getSnapshot).toMatchObject({
            provider: "opencodeV2",
            enabled: false,
            developmentOnly: true,
          });
        }
        yield* Effect.sleep("10 millis");
        expect(updates).toEqual([]);
      }),
    ).pipe(
      Effect.provide(
        ServerSettingsService.layerTest({ providers: { opencodeV2: { enabled: false } } }),
      ),
    ),
  );
});
