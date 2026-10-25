import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { makeRunStopAll } from "./ProviderService.operations.ts";
import {
  PROVIDER_STOP_ALL_ADAPTER_TIMEOUT,
  stopAdaptersWithin,
} from "./ProviderService.stopAll.ts";

type Adapters = Parameters<typeof makeRunStopAll>[0];

/** An adapter whose stopAll records start/end on a shared timeline and takes `ms` of clock time. */
const timedAdapter = (
  provider: string,
  timeline: string[],
  stop: Effect.Effect<void, string> = Effect.void,
) => ({
  provider,
  listSessions: () =>
    Effect.succeed([{ threadId: ThreadId.makeUnsafe(`${provider}-thread`), provider }]),
  stopAll: () =>
    Effect.sync(() => timeline.push(`stop:start:${provider}`)).pipe(
      Effect.andThen(stop),
      Effect.andThen(Effect.sync(() => timeline.push(`stop:end:${provider}`))),
    ),
});

const harness = (adapters: ReadonlyArray<ReturnType<typeof timedAdapter>>, timeline: string[]) => {
  const directory = {
    listThreadIds: () =>
      Effect.succeed(adapters.map((a) => ThreadId.makeUnsafe(`${a.provider}-thread`))),
    getProvider: (threadId: ThreadId) => Effect.succeed(threadId.replace(/-thread$/, "")),
    upsert: (binding: { threadId: ThreadId; status: string }) =>
      Effect.sync(() => timeline.push(`directory:${binding.status}:${binding.threadId}`)),
  } as unknown as ProviderSessionDirectoryShape;
  const upsertSessionBinding = (session: ProviderSession) =>
    Effect.sync(() => timeline.push(`binding:${session.threadId}`));
  const analytics = { record: () => Effect.void, flush: Effect.void } as unknown as Parameters<
    typeof makeRunStopAll
  >[3];
  return makeRunStopAll(
    adapters as unknown as Adapters,
    directory,
    upsertSessionBinding,
    analytics,
  );
};

describe("provider stop-all", () => {
  it.effect("stops adapters concurrently instead of one after another", () =>
    Effect.gen(function* () {
      const timeline: string[] = [];
      const adapters = ["cursor", "kilocode", "codex"].map((provider) =>
        timedAdapter(provider, timeline, Effect.sleep("1 second")),
      );
      const fiber = yield* Effect.forkChild(stopAdaptersWithin(adapters as unknown as Adapters));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(timeline.slice(0, 3), [
        "stop:start:cursor",
        "stop:start:kilocode",
        "stop:start:codex",
      ]);
      assert.strictEqual(timeline.length, 6);
    }),
  );

  it.effect("stops waiting for a hung adapter at the per-adapter timeout", () =>
    Effect.gen(function* () {
      const timeline: string[] = [];
      // Uninterruptible, like an adapter whose teardown runs inside a finalizer.
      const hung = timedAdapter("cursor", timeline, Effect.uninterruptible(Effect.never));
      const fiber = yield* Effect.forkChild(
        stopAdaptersWithin([hung, timedAdapter("claudeAgent", timeline)] as unknown as Adapters),
      );
      yield* TestClock.adjust("2999 millis");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(timeline, [
        "stop:start:cursor",
        "stop:start:claudeAgent",
        "stop:end:claudeAgent",
      ]);
    }),
  );

  it.effect("keeps binding persistence before the stops and directory upserts after them", () =>
    Effect.gen(function* () {
      const timeline: string[] = [];
      const adapters = [
        timedAdapter("cursor", timeline, Effect.never),
        timedAdapter("codex", timeline, Effect.fail("boom")),
        timedAdapter("claudeAgent", timeline, Effect.sleep("500 millis")),
      ];
      const fiber = yield* Effect.forkChild(harness(adapters, timeline));
      yield* TestClock.adjust(PROVIDER_STOP_ALL_ADAPTER_TIMEOUT);
      yield* Fiber.join(fiber);

      const firstStop = timeline.findIndex((entry) => entry.startsWith("stop:"));
      const lastStop = timeline.findLastIndex((entry) => entry.startsWith("stop:"));
      const bindings = timeline.filter((entry) => entry.startsWith("binding:"));
      const upserts = timeline.filter((entry) => entry.startsWith("directory:"));
      assert.strictEqual(bindings.length, 3);
      assert.ok(timeline.slice(0, firstStop).every((entry) => entry.startsWith("binding:")));
      // A failed and a timed-out adapter still let every thread be marked stopped afterwards.
      assert.deepStrictEqual(upserts, [
        "directory:stopped:cursor-thread",
        "directory:stopped:codex-thread",
        "directory:stopped:claudeAgent-thread",
      ]);
      assert.ok(timeline.indexOf(upserts[0]!) > lastStop);
    }),
  );
});
