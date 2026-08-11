import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, PubSub, Ref, Stream } from "effect";

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

describe("makeManagedServerProvider settings coordination", () => {
  it.layer(NodeServices.layer)("settings stream generations", (it) => {
    it.effect("does not supersede startup for the stream's unchanged initial replay", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settings = { binaryPath: "codex" };
          const probe = yield* Deferred.make<ServerProvider>();
          const verified = { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T20:00:00.000Z" };
          const service = yield* makeManagedServerProvider({
            getSettings: Effect.succeed(settings),
            streamSettings: Stream.make(settings),
            haveSettingsChanged: (previous, next) => previous.binaryPath !== next.binaryPath,
            checkProvider: Deferred.await(probe),
            initialSnapshot: {
              ...BASE_SNAPSHOT,
              status: "warning",
              checkedAt: "2026-07-06T19:00:00.000Z",
            },
            refreshInterval: "1 hour",
          });

          yield* Effect.yieldNow;
          yield* Deferred.succeed(probe, verified);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(yield* service.getSnapshot, {
            ...verified,
            initialProbeComplete: true,
          });
        }),
      ),
    );

    it.effect("does not publish an in-flight result after settings supersede it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* Ref.make({ binaryPath: "old" });
          const settingsChanges = yield* PubSub.unbounded<{ readonly binaryPath: string }>();
          const oldProbe = yield* Deferred.make<ServerProvider>();
          const probeCount = yield* Ref.make(0);
          const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
          const oldFailure = {
            ...BASE_SNAPSHOT,
            status: "error" as const,
            failure: { classification: "retryable" as const, reason: "process-failed" as const },
            checkedAt: "2026-07-06T20:00:00.000Z",
          };
          const newSuccess = { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T20:01:00.000Z" };
          const service = yield* makeManagedServerProvider({
            getSettings: Ref.get(settings),
            streamSettings: Stream.fromPubSub(settingsChanges),
            haveSettingsChanged: (previous, next) => previous.binaryPath !== next.binaryPath,
            checkProvider: Ref.updateAndGet(probeCount, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Deferred.await(oldProbe) : Effect.succeed(newSuccess),
              ),
            ),
            initialSnapshot: { ...BASE_SNAPSHOT, checkedAt: "2026-07-06T19:00:00.000Z" },
            refreshInterval: "1 hour",
          });
          yield* Stream.runForEach(service.streamChanges, (snapshot) =>
            Ref.update(published, (snapshots) => [...snapshots, snapshot]),
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;

          const nextSettings = { binaryPath: "new" };
          yield* Ref.set(settings, nextSettings);
          yield* PubSub.publish(settingsChanges, nextSettings);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(oldProbe, oldFailure);
          for (let index = 0; index < 10 && (yield* Ref.get(probeCount)) < 2; index += 1) {
            yield* Effect.yieldNow;
          }

          const snapshot = yield* service.getSnapshot;
          assert.strictEqual(snapshot.status, "ready");
          assert.strictEqual(snapshot.recovery, undefined);
          assert.deepStrictEqual(
            (yield* Ref.get(published)).map((item) => item.status),
            ["ready"],
          );
        }),
      ),
    );
  });
});
