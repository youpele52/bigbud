import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

const BASE_SNAPSHOT = {
  provider: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  models: [],
  slashCommands: [],
  skills: [],
} as const satisfies Omit<ServerProvider, "checkedAt">;

describe("makeManagedServerProvider", () => {
  it.layer(NodeServices.layer)("suppresses timestamp-only snapshot refreshes", (it) => {
    it.effect("keeps the cached snapshot stable across refreshes", () =>
      Effect.gen(function* () {
        const probesRef = yield* Ref.make(0);

        const service = yield* makeManagedServerProvider({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          checkProvider: Ref.updateAndGet(probesRef, (count) => count + 1).pipe(
            Effect.map((count) => ({
              ...BASE_SNAPSHOT,
              checkedAt: count === 1 ? "2026-07-06T20:00:00.000Z" : "2026-07-06T20:01:00.000Z",
            })),
          ),
          initialSnapshot: {
            ...BASE_SNAPSHOT,
            checkedAt: "2026-07-06T19:00:00.000Z",
          },
          refreshInterval: "1 hour",
        }).pipe(Effect.scoped);

        yield* service.getSnapshot;
        const refreshSnapshot = yield* service.refresh;

        assert.strictEqual(refreshSnapshot.initialProbeComplete, true);
        assert.strictEqual(yield* Ref.get(probesRef), 1);
      }),
    );

    it.effect("returns its seed before a suspended probe replaces it", () =>
      Effect.gen(function* () {
        const probe = yield* Deferred.make<ServerProvider>();
        const seed = {
          ...BASE_SNAPSHOT,
          status: "warning" as const,
          checkedAt: "2026-07-06T19:00:00.000Z",
        };
        const verified = {
          ...BASE_SNAPSHOT,
          checkedAt: "2026-07-06T20:00:00.000Z",
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* makeManagedServerProvider({
              getSettings: Effect.succeed({ enabled: true }),
              streamSettings: Stream.empty,
              haveSettingsChanged: () => false,
              checkProvider: Deferred.await(probe),
              initialSnapshot: seed,
              refreshInterval: "1 hour",
            });

            assert.deepStrictEqual(yield* service.getSnapshot, {
              ...seed,
              initialProbeComplete: false,
            });
            yield* Deferred.succeed(probe, verified);
            yield* Effect.yieldNow;

            assert.deepStrictEqual(yield* service.getSnapshot, {
              ...verified,
              initialProbeComplete: true,
            });
          }),
        );
      }),
    );

    it.effect("does not schedule startup or periodic probes for a disabled provider", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const probes = yield* Ref.make(0);
          const disabled = {
            ...BASE_SNAPSHOT,
            enabled: false,
            installed: false,
            status: "disabled" as const,
            checkedAt: "2026-07-06T19:00:00.000Z",
          };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ enabled: false }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProvider: Ref.update(probes, (count) => count + 1).pipe(Effect.as(disabled)),
            initialSnapshot: disabled,
            refreshInterval: "5 minutes",
          });

          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 minutes");
          yield* Effect.yieldNow;

          assert.strictEqual(yield* Ref.get(probes), 0);
          assert.strictEqual((yield* service.getSnapshot).recovery, undefined);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("marks startup failures for bounded background recovery", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const failed = {
            ...BASE_SNAPSHOT,
            installed: false,
            status: "error" as const,
            failure: { classification: "retryable" as const, reason: "startup-timeout" as const },
            checkedAt: "2026-07-06T20:00:00.000Z",
          };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProvider: Effect.succeed(failed),
            initialSnapshot: { ...failed, checkedAt: "2026-07-06T19:00:00.000Z" },
            refreshInterval: "1 hour",
          });

          yield* Effect.yieldNow;
          const snapshot = yield* service.getSnapshot;
          assert.strictEqual(snapshot.recovery?.attempt, 1);
          assert.strictEqual(snapshot.recovery?.maxAttempts, 5);
          assert.strictEqual(snapshot.recovery?.trigger, "startup");
          assert.strictEqual(snapshot.recovery?.status, "retrying");
          assert.strictEqual(snapshot.recovery?.generation, 1);
          assert.isString(snapshot.recovery?.operationId);
        }),
      ),
    );

    it.effect("retries a launch-time command-not-found result five times", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const probes = yield* Ref.make(0);
          const missing = {
            ...BASE_SNAPSHOT,
            installed: false,
            status: "error" as const,
            failure: {
              classification: "user-action-required" as const,
              reason: "command-not-found" as const,
            },
            checkedAt: "2026-07-06T20:00:00.000Z",
          };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProvider: Ref.update(probes, (count) => count + 1).pipe(Effect.as(missing)),
            initialSnapshot: { ...missing, checkedAt: "2026-07-06T19:00:00.000Z" },
            refreshInterval: "1 hour",
          });

          yield* Effect.yieldNow;
          assert.strictEqual((yield* service.getSnapshot).recovery?.attempt, 1);
          for (const delay of ["1 second", "3 seconds", "8 seconds", "20 seconds"] as const) {
            yield* TestClock.adjust(delay);
            yield* Effect.yieldNow;
          }
          const snapshot = yield* service.getSnapshot;
          assert.strictEqual(yield* Ref.get(probes), 5);
          assert.strictEqual(snapshot.recovery?.attempt, 5);
          assert.strictEqual(snapshot.recovery?.maxAttempts, 5);
          assert.strictEqual(snapshot.recovery?.trigger, "background");
          assert.strictEqual(snapshot.recovery?.status, "exhausted");
          assert.strictEqual(snapshot.recovery?.generation, 1);
          assert.isString(snapshot.recovery?.operationId);
          assert.deepStrictEqual(snapshot.failure, {
            classification: "user-action-required",
            reason: "command-not-found",
          });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("uses two lightweight launch probes before full background recovery", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launchProbes = yield* Ref.make(0);
          const fullProbes = yield* Ref.make(0);
          const missing = {
            ...BASE_SNAPSHOT,
            installed: false,
            status: "error" as const,
            failure: {
              classification: "user-action-required" as const,
              reason: "command-not-found" as const,
            },
            checkedAt: "2026-07-06T20:00:00.000Z",
          };
          const recovered = { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T20:01:00.000Z" };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProviderAtStartup: Ref.update(launchProbes, (count) => count + 1).pipe(
              Effect.as(missing),
            ),
            checkProvider: Ref.update(fullProbes, (count) => count + 1).pipe(Effect.as(recovered)),
            initialSnapshot: { ...missing, checkedAt: "2026-07-06T19:00:00.000Z" },
            refreshInterval: "1 hour",
          });

          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(launchProbes), 2);
          assert.strictEqual(yield* Ref.get(fullProbes), 0);
          assert.strictEqual((yield* service.getSnapshot).recovery?.trigger, "startup");

          yield* TestClock.adjust("3 seconds");
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(fullProbes), 1);
          assert.strictEqual((yield* service.getSnapshot).status, "ready");
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect("caps concurrent probes across managed providers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const active = yield* Ref.make(0);
          const peak = yield* Ref.make(0);
          const release = yield* Deferred.make<void>();
          const makeService = (provider: ServerProvider["provider"]) =>
            makeManagedServerProvider({
              getSettings: Effect.succeed({ enabled: true }),
              streamSettings: Stream.empty,
              haveSettingsChanged: () => false,
              checkProvider: Ref.updateAndGet(active, (count) => count + 1).pipe(
                Effect.tap((count) => Ref.update(peak, (current) => Math.max(current, count))),
                Effect.andThen(Deferred.await(release)),
                Effect.ensuring(Ref.update(active, (count) => count - 1)),
                Effect.as({ ...BASE_SNAPSHOT, provider, checkedAt: "2026-07-06T20:00:00.000Z" }),
              ),
              initialSnapshot: {
                ...BASE_SNAPSHOT,
                provider,
                checkedAt: "2026-07-06T19:00:00.000Z",
              },
              refreshInterval: "1 hour",
            });

          yield* Effect.forEach(["codex", "copilot", "cursor", "devin"] as const, makeService);
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(peak), 3);
          yield* Deferred.succeed(release, undefined);
        }),
      ),
    );

    it.effect("suppresses a stale startup result after a manual recovery", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstProbe = yield* Deferred.make<ServerProvider>();
          const probes = yield* Ref.make(0);
          const failed = {
            ...BASE_SNAPSHOT,
            status: "error" as const,
            failure: { classification: "retryable" as const, reason: "startup-timeout" as const },
            checkedAt: "2026-07-06T20:00:00.000Z",
          };
          const recovered = { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T20:01:00.000Z" };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProvider: Ref.updateAndGet(probes, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Deferred.await(firstProbe) : Effect.succeed(recovered),
              ),
            ),
            initialSnapshot: { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T19:00:00.000Z" },
            refreshInterval: "1 hour",
          });

          const manual = yield* service
            .refreshWithRecovery({ attempt: 1, maxAttempts: 3, trigger: "manual" })
            .pipe(Effect.forkScoped);
          yield* Deferred.succeed(firstProbe, failed);
          const result = yield* Fiber.join(manual);
          assert.strictEqual(result.status, "ready");
          assert.strictEqual((yield* service.getSnapshot).status, "ready");
          assert.strictEqual(yield* Ref.get(probes), 2);
        }),
      ),
    );

    it.effect("manual recovery cancels a pending background launch retry", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const launchProbes = yield* Ref.make(0);
          const fullProbes = yield* Ref.make(0);
          const failed = {
            ...BASE_SNAPSHOT,
            installed: false,
            status: "error" as const,
            failure: {
              classification: "user-action-required" as const,
              reason: "command-not-found" as const,
            },
            checkedAt: "2026-07-06T20:00:00.000Z",
          };
          const recovered = { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T20:01:00.000Z" };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: () => false,
            checkProviderAtStartup: Ref.update(launchProbes, (count) => count + 1).pipe(
              Effect.as(failed),
            ),
            checkProvider: Ref.update(fullProbes, (count) => count + 1).pipe(Effect.as(recovered)),
            initialSnapshot: { ...failed, checkedAt: "2026-07-06T19:00:00.000Z" },
            refreshInterval: "1 hour",
          });

          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(launchProbes), 2);

          const manual = yield* service.refreshWithRecovery({
            attempt: 1,
            maxAttempts: 3,
            trigger: "manual",
          });
          assert.strictEqual(manual.status, "ready");
          assert.strictEqual(yield* Ref.get(fullProbes), 1);

          yield* TestClock.adjust("3 seconds");
          yield* Effect.yieldNow;
          assert.strictEqual(yield* Ref.get(fullProbes), 1);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
