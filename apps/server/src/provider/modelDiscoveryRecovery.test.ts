import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeModelDiscoveryRecovery } from "./modelDiscoveryRecovery";

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
const live: ServerProvider = {
  ...fallback,
  models: [{ slug: "live", name: "Live", isCustom: false, capabilities: null }],
  modelDiscovery: { status: "live", source: "source", durationMs: 0 },
};

describe("model discovery recovery", () => {
  it.effect("interrupts an in-flight background probe before starting a fresh cycle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recover = yield* makeModelDiscoveryRecovery();
        let calls = 0;
        let active = false;
        let cancelled = false;
        yield* recover({
          identity: "a",
          generation: 1,
          isCurrent: Effect.succeed(true),
          retryDelays: [1, 1, 1],
          probe: Effect.suspend(() => {
            calls++;
            if (calls <= 2) return Effect.succeed(fallback);
            active = true;
            return Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active = false;
                  cancelled = true;
                }),
              ),
            );
          }),
          publish: () => Effect.void,
        });
        yield* TestClock.adjust(1);
        assert.strictEqual(active, true);
        yield* recover({
          identity: "a",
          generation: 2,
          isCurrent: Effect.succeed(true),
          probe: Effect.sync(() => {
            assert.strictEqual(active, false);
            return live;
          }),
          publish: () => Effect.void,
        });
        assert.strictEqual(cancelled, true);
      }),
    ),
  );

  it.effect("tries twice before fallback and exactly three more times in the background", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recover = yield* makeModelDiscoveryRecovery();
        let calls = 0;
        const published: ServerProvider[] = [];
        const result = yield* recover({
          identity: "a",
          generation: 1,
          isCurrent: Effect.succeed(true),
          retryDelays: [1, 1, 1],
          probe: Effect.sync(() => {
            calls++;
            return fallback;
          }),
          publish: (snapshot) =>
            Effect.sync(() => {
              published.push(snapshot);
            }),
        });
        assert.strictEqual(calls, 2);
        assert.strictEqual(published.length, 0);
        assert.strictEqual(result.modelRecovery?.status, "retrying");
        yield* TestClock.adjust(10);
        assert.strictEqual(calls, 5);
        assert.strictEqual(published.at(-1)?.modelRecovery?.status, "exhausted");
        yield* TestClock.adjust(60_000);
        assert.strictEqual(calls, 5);
      }),
    ),
  );

  it.effect("accepts the second source result without activating fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recover = yield* makeModelDiscoveryRecovery();
        let calls = 0;
        const result = yield* recover({
          identity: "a",
          generation: 1,
          isCurrent: Effect.succeed(true),
          probe: Effect.sync(() => (++calls === 1 ? fallback : live)),
          publish: () => Effect.die("unexpected publish"),
        });
        assert.deepStrictEqual(result, live);
        assert.strictEqual(calls, 2);
      }),
    ),
  );

  it.effect("replaces fallback as soon as a background source succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recover = yield* makeModelDiscoveryRecovery();
        let calls = 0;
        const published: ServerProvider[] = [];
        yield* recover({
          identity: "a",
          generation: 1,
          isCurrent: Effect.succeed(true),
          retryDelays: [1, 1, 1],
          probe: Effect.sync(() => (++calls < 4 ? fallback : live)),
          publish: (snapshot) =>
            Effect.sync(() => {
              published.push(snapshot);
            }),
        });
        yield* TestClock.adjust(10);
        assert.strictEqual(calls, 4);
        assert.deepStrictEqual(published.at(-1)?.models, live.models);
        assert.strictEqual(published.at(-1)?.modelRecovery?.status, "recovered");
      }),
    ),
  );

  it.effect(
    "retains last good only for the same settings identity; refresh cancels old retries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const recover = yield* makeModelDiscoveryRecovery();
          let calls = 0;
          const base = {
            generation: 1,
            isCurrent: Effect.succeed(true),
            publish: () => Effect.void,
            retryDelays: [1, 1, 1] as const,
          };
          yield* recover({ ...base, identity: "a", probe: Effect.succeed(live) });
          const cached = yield* recover({
            ...base,
            identity: "a",
            probe: Effect.sync(() => {
              calls++;
              return fallback;
            }),
          });
          assert.deepStrictEqual(cached.models, live.models);
          const changed = yield* recover({
            ...base,
            identity: "b",
            probe: Effect.succeed(fallback),
          });
          assert.deepStrictEqual(changed.models, fallback.models);
          yield* TestClock.adjust(10);
          assert.strictEqual(calls, 2);
        }),
      ),
  );

  it.effect("does not publish superseded results or retry an empty live catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recover = yield* makeModelDiscoveryRecovery();
        let current = true;
        let calls = 0;
        yield* recover({
          identity: "a",
          generation: 1,
          isCurrent: Effect.sync(() => current),
          retryDelays: [1, 1, 1],
          probe: Effect.sync(() => {
            calls++;
            return fallback;
          }),
          publish: () => Effect.die("stale publish"),
        });
        current = false;
        yield* TestClock.adjust(10);
        assert.strictEqual(calls, 2);
        const empty = {
          ...live,
          models: [],
          modelDiscovery: { ...live.modelDiscovery!, status: "empty" as const },
        };
        const result = yield* recover({
          identity: "a",
          generation: 2,
          isCurrent: Effect.succeed(true),
          probe: Effect.succeed(empty),
          publish: () => Effect.die("unexpected publish"),
        });
        assert.deepStrictEqual(result.models, []);
        assert.strictEqual(result.modelRecovery, undefined);
      }),
    ),
  );
});
