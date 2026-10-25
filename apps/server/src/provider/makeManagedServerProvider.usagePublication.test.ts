import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";

function quota(utilization: number): ServerProviderUsageLimits {
  return {
    source: "codex-app-server",
    status: "available",
    checkedAt: "2026-10-21T12:00:00.000Z",
    windows: [{ id: "primary", kind: "five-hour", label: "5-hour limit", utilization }],
    manualResets: { availableCount: utilization, availableExpiries: [], detailsComplete: false },
  };
}

const live: ServerProvider = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T12:00:00.000Z",
  models: [{ slug: "live", name: "Live", isCustom: false, capabilities: null }],
  modelDiscovery: { status: "live", source: "source", durationMs: 0 },
  slashCommands: [],
  skills: [],
  usageLimits: quota(10),
};
const base = {
  initialSnapshot: live,
  getSettings: Effect.succeed(true),
  streamSettings: Stream.empty,
  haveSettingsChanged: (a: boolean, b: boolean) => a !== b,
  recoverModelDiscovery: true,
  refreshInterval: "1 hour",
  checkProvider: Effect.succeed(live),
} as const;

describe("independent quota publication", () => {
  it.effect.each(["available", "error", "unavailable"] as const)(
    "delayed enrichment keeps the latest %s quota without cancelling capabilities",
    (status) =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const finished = yield* Deferred.make<void>();
          const published = yield* Deferred.make<ServerProvider>();
          let calls = 0;
          let nextQuota: ServerProviderUsageLimits = quota(70);
          const service = yield* makeManagedServerProvider({
            ...base,
            checkProvider: Effect.sync(() => {
              calls++;
              return live;
            }),
            readUsageLimits: () => Effect.sync(() => nextQuota),
            enrichSnapshot: ({ snapshot, publishSnapshot }) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                yield* publishSnapshot({
                  ...snapshot,
                  version: "enriched",
                  models: [{ ...live.models[0]!, name: "Enriched" }],
                });
                yield* Deferred.succeed(finished, undefined);
              }),
          });
          yield* Stream.runForEach(service.streamChanges, (snapshot) =>
            snapshot.version === "enriched" ? Deferred.succeed(published, snapshot) : Effect.void,
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          assert.deepStrictEqual((yield* service.refreshUsageLimits!).usageLimits, quota(70));
          nextQuota =
            status === "available"
              ? quota(80)
              : { ...quota(80), status, windows: [], manualResets: undefined };
          assert.deepStrictEqual((yield* service.refreshUsageLimits!).usageLimits, nextQuota);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(finished);
          assert.deepStrictEqual((yield* Deferred.await(published)).usageLimits, nextQuota);
          const current = yield* service.getSnapshot;
          assert.deepStrictEqual(current.usageLimits, nextQuota);
          assert.strictEqual(current.models[0]?.name, "Enriched");
          assert.strictEqual(calls, 1);
        }),
      ),
  );

  it.effect(
    "model retry and recovery publications preserve refreshed quota while discovery completes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const initialGate = yield* Deferred.make<void>();
          const foregroundReady = yield* Deferred.make<void>();
          const retryStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const recovered = yield* Deferred.make<ServerProvider>();
          const fallback = {
            ...live,
            modelDiscovery: { status: "unavailable" as const, source: "fallback", durationMs: 0 },
          };
          let probes = 0;
          const events: ServerProvider[] = [];
          const service = yield* makeManagedServerProvider({
            ...base,
            initialSnapshot: fallback,
            readUsageLimits: () => Effect.succeed(quota(70)),
            checkProvider: Effect.gen(function* () {
              yield* Deferred.await(initialGate);
              if (++probes <= 2) return fallback;
              yield* Deferred.succeed(retryStarted, undefined);
              yield* Deferred.await(release);
              return live;
            }),
          });
          yield* Stream.runForEach(service.streamChanges, (snapshot) =>
            Effect.gen(function* () {
              events.push(snapshot);
              if (snapshot.modelRecovery?.attempt === 0)
                yield* Deferred.succeed(foregroundReady, undefined);
              if (snapshot.modelRecovery?.status === "recovered")
                yield* Deferred.succeed(recovered, snapshot);
            }),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(initialGate, undefined);
          yield* Deferred.await(foregroundReady);
          assert.deepStrictEqual((yield* service.refreshUsageLimits!).usageLimits, quota(70));
          assert.strictEqual((yield* service.getSnapshot).modelRecovery?.status, "retrying");
          yield* TestClock.adjust(1_000);
          yield* Deferred.await(retryStarted);
          const retrying = yield* service.getSnapshot;
          assert.strictEqual(retrying.modelRecovery?.attempt, 1);
          assert.deepStrictEqual(retrying.usageLimits, quota(70));
          yield* Deferred.succeed(release, undefined);
          const final = yield* Deferred.await(recovered);
          assert.deepStrictEqual(final.usageLimits, quota(70));
          assert.deepStrictEqual(final.models, live.models);
          assert.strictEqual(probes, 3);
          assert.ok(
            events
              .filter((snapshot) => snapshot.modelRecovery?.attempt === 1)
              .every((snapshot) => snapshot.usageLimits?.windows[0]?.utilization === 70),
          );
        }),
      ),
  );

  it.effect(
    "a recovery publication already blocked in decoration cannot restore captured quota",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const decorating = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const recovered = yield* Deferred.make<ServerProvider>();
          const fallback = {
            ...live,
            modelDiscovery: { status: "unavailable" as const, source: "fallback", durationMs: 0 },
          };
          let probes = 0;
          const service = yield* makeManagedServerProvider({
            ...base,
            initialSnapshot: fallback,
            checkProvider: Effect.sync(() => (++probes <= 2 ? fallback : live)),
            readUsageLimits: () => Effect.succeed(quota(70)),
            decorateSnapshot: ({ snapshot }) =>
              Effect.gen(function* () {
                if (snapshot.modelRecovery?.status === "recovered") {
                  yield* Deferred.succeed(decorating, undefined);
                  yield* Deferred.await(release);
                }
                return snapshot;
              }),
          });
          yield* Stream.runForEach(service.streamChanges, (snapshot) =>
            snapshot.modelRecovery?.status === "recovered"
              ? Deferred.succeed(recovered, snapshot)
              : Effect.void,
          ).pipe(Effect.forkScoped);
          yield* TestClock.adjust(1_000);
          yield* Deferred.await(decorating);
          assert.deepStrictEqual((yield* service.refreshUsageLimits!).usageLimits, quota(70));
          yield* Deferred.succeed(release, undefined);
          assert.deepStrictEqual((yield* Deferred.await(recovered)).usageLimits, quota(70));
          assert.deepStrictEqual((yield* service.getSnapshot).models, live.models);
        }),
      ),
  );

  it.effect("preserves refreshed quota through model discovery exhaustion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exhausted = yield* Deferred.make<ServerProvider>();
        let probes = 0;
        const service = yield* makeManagedServerProvider({
          ...base,
          checkProvider: Effect.sync(() => {
            probes++;
            return {
              ...live,
              modelDiscovery: { status: "unavailable" as const, source: "fallback", durationMs: 0 },
            };
          }),
          readUsageLimits: () => Effect.succeed(quota(70)),
        });
        yield* Stream.runForEach(service.streamChanges, (snapshot) =>
          snapshot.modelRecovery?.status === "exhausted"
            ? Deferred.succeed(exhausted, snapshot)
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.strictEqual((yield* service.getSnapshot).modelRecovery?.attempt, 0);
        yield* service.refreshUsageLimits!;
        yield* TestClock.adjust(14_000);
        assert.deepStrictEqual((yield* Deferred.await(exhausted)).usageLimits, quota(70));
        assert.strictEqual(probes, 5);
      }),
    ),
  );

  it.effect("later periodic and explicit probes can still publish newly fetched quota", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let probedQuota = quota(10);
        const service = yield* makeManagedServerProvider({
          ...base,
          refreshInterval: "1 second",
          checkProvider: Effect.sync(() => ({ ...live, usageLimits: probedQuota })),
          readUsageLimits: () => Effect.succeed(quota(70)),
        });
        assert.deepStrictEqual((yield* service.refreshUsageLimits!).usageLimits, quota(70));
        probedQuota = quota(90);
        yield* TestClock.adjust(1_000);
        assert.deepStrictEqual((yield* service.getSnapshot).usageLimits, quota(90));
        assert.deepStrictEqual((yield* service.refreshUsageLimits!).usageLimits, quota(70));
        probedQuota = quota(95);
        assert.deepStrictEqual((yield* service.refresh).usageLimits, quota(95));
      }),
    ),
  );
});
