import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Ref, Stream } from "effect";

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

        const initialSnapshot = yield* service.getSnapshot;
        const refreshSnapshot = yield* service.refresh;

        assert.deepStrictEqual(refreshSnapshot, initialSnapshot);
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

            assert.deepStrictEqual(yield* service.getSnapshot, seed);
            yield* Deferred.succeed(probe, verified);
            yield* Effect.yieldNow;

            assert.deepStrictEqual(yield* service.getSnapshot, verified);
          }),
        );
      }),
    );
  });
});
