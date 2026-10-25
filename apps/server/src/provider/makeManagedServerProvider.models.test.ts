import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeManagedServerProvider } from "./makeManagedServerProvider";

const fallback: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: [{ slug: "seed", name: "Seed", isCustom: false, capabilities: null }],
  modelDiscovery: { status: "unavailable", source: "fallback", durationMs: 0 },
  slashCommands: [],
  skills: [],
};
describe("managed model discovery", () => {
  it.effect(
    "exposes static fallback after two whole-probe timeouts and retains it after five",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const service = yield* makeManagedServerProvider({
            initialSnapshot: fallback,
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            recoverModelDiscovery: true,
            refreshInterval: "1 hour",
            probeTimeout: 1,
            checkProvider: Effect.sync(() => {
              calls++;
            }).pipe(Effect.andThen(Effect.never)),
          });
          assert.deepStrictEqual((yield* service.getSnapshot).models, []);
          yield* TestClock.adjust(1);
          assert.deepStrictEqual((yield* service.getSnapshot).models, []);
          yield* TestClock.adjust(1);
          assert.strictEqual(calls, 2);
          assert.deepStrictEqual((yield* service.getSnapshot).models, fallback.models);
          yield* TestClock.adjust(15_000);
          assert.strictEqual(calls, 5);
          assert.deepStrictEqual((yield* service.getSnapshot).models, fallback.models);
          assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "exhausted");
        }),
      ),
  );

  it.effect("uses last-good on whole-probe errors and rebuilds fallback for changed settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* Ref.make("old");
        let fail = false;
        const live = {
          ...fallback,
          models: [{ slug: "live", name: "Live", isCustom: false, capabilities: null }],
          modelDiscovery: { status: "live" as const, source: "source", durationMs: 0 },
        };
        const service = yield* makeManagedServerProvider({
          initialSnapshot: (name: string) => ({
            ...fallback,
            models: [{ slug: name, name, isCustom: true, capabilities: null }],
          }),
          getSettings: Ref.get(settings),
          streamSettings: Stream.empty,
          haveSettingsChanged: (a, b) => a !== b,
          recoverModelDiscovery: true,
          refreshInterval: "1 hour",
          checkProvider: Effect.suspend(() =>
            fail ? Effect.die(new Error("whole probe failed")) : Effect.succeed(live),
          ),
        });
        yield* Effect.yieldNow;
        fail = true;
        assert.deepStrictEqual((yield* service.refresh).models, live.models);
        yield* Ref.set(settings, "new");
        assert.strictEqual((yield* service.refresh).models[0]?.slug, "new");
      }),
    ),
  );

  it.effect("withholds initial fallback, replaces it in background, and truly refreshes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        let calls = 0;
        const live = {
          ...fallback,
          models: [{ slug: "live", name: "Live", isCustom: false, capabilities: null }],
          modelDiscovery: { status: "live" as const, source: "source", durationMs: 0 },
        };
        const service = yield* makeManagedServerProvider({
          initialSnapshot: fallback,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          recoverModelDiscovery: true,
          refreshInterval: "1 hour",
          checkProvider: Deferred.await(gate).pipe(
            Effect.map(() => (++calls < 3 ? fallback : live)),
          ),
        });
        assert.deepStrictEqual((yield* service.getSnapshot).models, []);
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.yieldNow;
        assert.strictEqual(calls, 2);
        assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "retrying");
        yield* TestClock.adjust(1_000);
        assert.deepStrictEqual((yield* service.getSnapshot).models, live.models);
        assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "recovered");
        yield* service.refreshWithRecovery({ trigger: "manual", attempt: 1, maxAttempts: 1 });
        assert.strictEqual(calls, 4);
      }),
    ),
  );

  it.effect("counts enrichment source attempts, not the availability-only fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* makeManagedServerProvider({
          initialSnapshot: fallback,
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          recoverModelDiscovery: true,
          refreshInterval: "1 hour",
          checkProvider: Effect.succeed(fallback),
          checkProviderAtStartup: Effect.succeed(fallback),
          discoverSnapshot: ({ publishSnapshot }) =>
            Effect.sync(() => {
              calls++;
            }).pipe(Effect.andThen(publishSnapshot(fallback))),
        });
        yield* Effect.yieldNow;
        assert.strictEqual(calls, 2);
        assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "retrying");
        yield* TestClock.adjust(14_000);
        assert.strictEqual(calls, 5);
        assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "exhausted");
      }),
    ),
  );
});
