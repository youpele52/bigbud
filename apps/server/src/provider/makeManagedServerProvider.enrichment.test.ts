import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Ref, Stream, PubSub } from "effect";
import { TestClock } from "effect/testing";
import { makeManagedServerProvider } from "./makeManagedServerProvider";

const live: ServerProvider = {
  provider: "cursor",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: [{ slug: "live", name: "Live", isCustom: false, capabilities: null }],
  modelDiscovery: { status: "live", source: "source", durationMs: 0 },
  slashCommands: [],
  skills: [],
};
const base = {
  initialSnapshot: live,
  getSettings: Effect.succeed(true),
  streamSettings: Stream.empty,
  haveSettingsChanged: (a: boolean, b: boolean) => a !== b,
  recoverModelDiscovery: true,
  refreshInterval: "1 hour",
  probeTimeout: 10,
  checkProvider: Effect.succeed(live),
} as const;

describe("optional managed provider enrichment", () => {
  it.effect(
    "publishes the live catalog and lets other providers and manual refresh complete while enrichment is blocked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const probeGate = yield* Deferred.make<void>();
          const readyPublished = yield* Deferred.make<ServerProvider>();
          let cancelled = 0;
          let running = 0;
          let maximum = 0;
          const service = yield* makeManagedServerProvider({
            ...base,
            checkProvider: Deferred.await(probeGate).pipe(Effect.as(live)),
            enrichSnapshot: () =>
              Effect.gen(function* () {
                running++;
                maximum = Math.max(maximum, running);
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    cancelled++;
                    running--;
                  }),
                ),
              ),
          });
          yield* Stream.runForEach(service.streamChanges, (snapshot) =>
            snapshot.initialProbeComplete
              ? Deferred.succeed(readyPublished, snapshot)
              : Effect.void,
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(probeGate, undefined);
          yield* Deferred.await(started);
          assert.deepStrictEqual((yield* Deferred.await(readyPublished)).models, live.models);
          const snapshot = yield* service.getSnapshot;
          assert.strictEqual(snapshot.initialProbeComplete, true);
          assert.deepStrictEqual(snapshot.models, live.models);
          const other = yield* makeManagedServerProvider({
            ...base,
            initialSnapshot: { ...live, provider: "devin" },
            checkProvider: Effect.succeed({ ...live, provider: "devin" }),
          });
          yield* Effect.yieldNow;
          assert.strictEqual((yield* other.getSnapshot).initialProbeComplete, true);
          const refreshed = yield* service.refreshWithRecovery({
            trigger: "manual",
            attempt: 1,
            maxAttempts: 1,
          });
          assert.deepStrictEqual(refreshed.models, live.models);
          yield* Effect.yieldNow;
          assert.strictEqual(cancelled, 1);
          assert.strictEqual(maximum, 1);
        }),
      ),
  );

  it.effect(
    "bounds optional work, keeps the live catalog and rejects a late callback after timeout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          let stopped = false;
          let publishLate: Effect.Effect<void> = Effect.void;
          const service = yield* makeManagedServerProvider({
            ...base,
            enrichmentTimeout: 25,
            enrichSnapshot: ({ publishSnapshot }) =>
              Effect.gen(function* () {
                publishLate = publishSnapshot({ ...live, models: [] });
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    stopped = true;
                  }),
                ),
              ),
          });
          yield* Deferred.await(started);
          yield* TestClock.adjust(25);
          assert.strictEqual(stopped, true);
          yield* publishLate;
          assert.deepStrictEqual((yield* service.getSnapshot).models, live.models);
        }),
      ),
  );

  it.effect("cancels on settings disable and fences callbacks retained by the old generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* Ref.make(true);
        const changes = yield* PubSub.unbounded<boolean>();
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        let publishLate: Effect.Effect<void> = Effect.void;
        let enrichments = 0;
        const service = yield* makeManagedServerProvider({
          ...base,
          getSettings: Ref.get(settings),
          streamSettings: Stream.fromPubSub(changes),
          checkProvider: Ref.get(settings).pipe(Effect.map((enabled) => ({ ...live, enabled }))),
          enrichSnapshot: ({ publishSnapshot }) =>
            Effect.gen(function* () {
              enrichments++;
              publishLate = publishSnapshot({ ...live, version: "stale" });
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
        });
        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        yield* Ref.set(settings, false);
        yield* PubSub.publish(changes, false);
        yield* Deferred.await(stopped);
        yield* Effect.yieldNow;
        yield* publishLate;
        const snapshot = yield* service.getSnapshot;
        assert.strictEqual(snapshot.enabled, false);
        assert.notStrictEqual(snapshot.version, "stale");
        assert.strictEqual(enrichments, 1);
      }),
    ),
  );

  it.effect("cancels optional work when the provider scope closes", () =>
    Effect.gen(function* () {
      let stopped = false;
      let publishLate: Effect.Effect<void> = Effect.void;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          yield* makeManagedServerProvider({
            ...base,
            enrichSnapshot: ({ publishSnapshot }) =>
              Effect.gen(function* () {
                publishLate = publishSnapshot({ ...live, models: [] });
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    stopped = true;
                  }),
                ),
              ),
          });
          yield* Deferred.await(started);
          yield* Effect.yieldNow;
        }),
      );
      assert.strictEqual(stopped, true);
      yield* publishLate;
    }),
  );

  it.effect("publishes successful optional updates without changing recovery metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const service = yield* makeManagedServerProvider({
          ...base,
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Deferred.await(release).pipe(
              Effect.andThen(publishSnapshot({ ...snapshot, version: "enriched" })),
            ),
        });
        yield* Effect.yieldNow;
        const initial = yield* service.getSnapshot;
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        const enriched = yield* service.getSnapshot;
        assert.strictEqual(enriched.version, "enriched");
        assert.deepStrictEqual(enriched.recovery, initial.recovery);
        assert.deepStrictEqual(enriched.modelDiscovery, initial.modelDiscovery);
      }),
    ),
  );

  it.effect("preserves a successful core catalog when optional enrichment fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeManagedServerProvider({
          ...base,
          enrichSnapshot: () => Effect.die(new Error("capabilities failed")),
        });
        yield* Effect.yieldNow;
        assert.deepStrictEqual((yield* service.getSnapshot).models, live.models);
        assert.strictEqual((yield* service.getSnapshot).initialProbeComplete, true);
      }),
    ),
  );

  it.effect("enriches a catalog recovered in the background, not its fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let probes = 0;
        let enrichments = 0;
        const fallback = {
          ...live,
          modelDiscovery: { status: "unavailable" as const, source: "fallback", durationMs: 0 },
        };
        const service = yield* makeManagedServerProvider({
          ...base,
          checkProvider: Effect.sync(() => (++probes < 3 ? fallback : live)),
          enrichSnapshot: ({ snapshot, publishSnapshot }) =>
            Effect.sync(() => {
              enrichments++;
            }).pipe(Effect.andThen(publishSnapshot({ ...snapshot, version: "enriched" }))),
        });
        yield* Effect.yieldNow;
        assert.strictEqual(enrichments, 0);
        yield* TestClock.adjust(1_000);
        assert.strictEqual(enrichments, 1);
        assert.strictEqual((yield* service.getSnapshot).version, "enriched");
        assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "recovered");
      }),
    ),
  );

  it.effect(
    "bounds actual source discovery and preserves two initial plus three background attempts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let attempts = 0;
          let interrupted = 0;
          const fallback = {
            ...live,
            modelDiscovery: { status: "unavailable" as const, source: "fallback", durationMs: 0 },
          };
          const service = yield* makeManagedServerProvider({
            ...base,
            initialSnapshot: fallback,
            checkProvider: Effect.succeed(fallback),
            discoverSnapshot: () =>
              Effect.sync(() => {
                attempts++;
              }).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    interrupted++;
                  }),
                ),
              ),
          });
          yield* TestClock.adjust(10);
          assert.deepStrictEqual((yield* service.getSnapshot).models, []);
          yield* TestClock.adjust(10);
          assert.strictEqual(attempts, 2);
          assert.strictEqual((yield* service.getSnapshot).modelDiscovery?.status, "unavailable");
          yield* TestClock.adjust(15_000);
          assert.strictEqual(attempts, 5);
          assert.strictEqual(interrupted, 5);
          assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "exhausted");
        }),
      ),
  );
});
