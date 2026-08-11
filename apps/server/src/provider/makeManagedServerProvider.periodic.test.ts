import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

const ready: ServerProvider = {
  provider: "opencode",
  enabled: true,
  installed: true,
  version: "1.17.18",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-11T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("makeManagedServerProvider periodic policy", () => {
  it.effect("checks healthy providers at five minutes rather than every minute", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        yield* makeManagedServerProvider({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          checkProvider: Ref.update(probes, (count) => count + 1).pipe(Effect.as(ready)),
          initialSnapshot: ready,
        });

        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(probes), 1);
        yield* TestClock.adjust("299 seconds");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(probes), 1);
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(probes), 2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not periodically probe a user-action-required failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const requiresAuth: ServerProvider = {
          ...ready,
          status: "error",
          auth: { status: "unauthenticated" },
          failure: {
            classification: "user-action-required",
            reason: "authentication-required",
          },
        };
        yield* makeManagedServerProvider({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          checkProvider: Ref.update(probes, (count) => count + 1).pipe(Effect.as(requiresAuth)),
          initialSnapshot: requiresAuth,
        });

        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(probes), 1);
        yield* TestClock.adjust("10 minutes");
        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(probes), 1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
