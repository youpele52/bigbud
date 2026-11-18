import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings.ts";

const production = ServerSettingsLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "bigbud-settings-barrier-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

for (const [name, layer] of [
  ["production", production],
  ["test", ServerSettingsService.layerTest()],
] as const) {
  it.layer(layer)(`${name} accepted settings barrier`, (it) => {
    it.effect("holds the accepted snapshot through preparation and reads after acquisition", () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.start;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writeStarted = yield* Deferred.make<void>();
        const written = yield* Deferred.make<void>();
        const barrier = yield* Effect.forkChild(
          settings.withSnapshotBarrier!((snapshot) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              assert.strictEqual(settings.currentSnapshot!(), snapshot);
            }),
          ),
        );
        yield* Deferred.await(entered);
        const writer = yield* Effect.forkChild(
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(
              settings.updateSettings({
                textGenerationModelSelection: { provider: "codex", model: "new-model" },
              }),
            ),
            Effect.andThen(Deferred.succeed(written, undefined)),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(writeStarted);
        yield* Effect.yieldNow;
        const reader = yield* Effect.forkChild(
          settings.withSnapshotBarrier!((snapshot) =>
            Effect.succeed(snapshot.settings.textGenerationModelSelection),
          ),
          { startImmediately: true },
        );
        assert.isFalse(yield* Deferred.isDone(written));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(barrier);
        yield* Fiber.join(writer);
        assert.strictEqual((yield* Fiber.join(reader))?.model, "new-model");
      }),
    );

    it.effect("releases the barrier on cancellation and preserves caller failures", () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* settings.start;
        const entered = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          settings.withSnapshotBarrier!(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(holder);
        const result = yield* settings.withSnapshotBarrier!(() =>
          Effect.fail("caller-failure"),
        ).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure, "caller-failure");
        yield* settings.updateSettings({ textGenerationModelSelection: null });
        assert.isNull(
          yield* settings.withSnapshotBarrier!((snapshot) =>
            Effect.succeed(snapshot.settings.textGenerationModelSelection),
          ),
        );
      }),
    );
  });
}
