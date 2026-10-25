import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { makeManagedServerProvider } from "./makeManagedServerProvider";

const seed: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("managed provider decoration generations", () => {
  it.effect(
    "does not commit or publish a decorated snapshot superseded while awaiting decoration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const decorating = yield* Deferred.make<void>();
          const releaseDecorator = yield* Deferred.make<void>();
          const freshProbeStarted = yield* Deferred.make<void>();
          const releaseFreshProbe = yield* Deferred.make<void>();
          let probes = 0;
          const published: ServerProvider[] = [];
          const service = yield* makeManagedServerProvider({
            initialSnapshot: seed,
            getSettings: Effect.succeed("settings"),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            refreshInterval: "1 hour",
            checkProvider: Effect.gen(function* () {
              probes++;
              if (probes > 1) {
                yield* Deferred.succeed(freshProbeStarted, undefined);
                yield* Deferred.await(releaseFreshProbe);
              }
              return { ...seed, version: probes === 1 ? "stale" : "fresh" };
            }),
            decorateSnapshot: ({ snapshot }) =>
              snapshot.version === "stale"
                ? Deferred.succeed(decorating, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseDecorator)),
                    Effect.as(snapshot),
                  )
                : Effect.succeed(snapshot),
          });
          yield* Stream.runForEach(service.streamChanges, (snapshot) =>
            Effect.sync(() => {
              published.push(snapshot);
            }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(decorating);
          const manual = yield* service
            .refreshWithRecovery({ trigger: "manual", attempt: 1, maxAttempts: 1 })
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseDecorator, undefined);
          yield* Deferred.await(freshProbeStarted);
          assert.strictEqual((yield* service.getSnapshot).version, "1");
          assert.strictEqual(
            published.some((snapshot) => snapshot.version === "stale"),
            false,
          );
          yield* Deferred.succeed(releaseFreshProbe, undefined);
          assert.strictEqual((yield* Fiber.join(manual)).version, "fresh");
          assert.strictEqual(
            published.some((snapshot) => snapshot.version === "stale"),
            false,
          );
        }),
      ),
  );
});
