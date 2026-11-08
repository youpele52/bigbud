import type { ProviderRuntimeEvent, ProviderSession } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  type ProviderRuntimeReconcileInput,
  ProviderSessionRuntimeRepository,
} from "../../persistence/Services/ProviderSessionRuntime.ts";
import { makeProviderRuntimeHygiene } from "./ProviderRuntimeIngestion.runtimeHygiene.ts";

const calls: ProviderRuntimeReconcileInput[] = [];
const repositoryLayer = Layer.succeed(ProviderSessionRuntimeRepository, {
  reconcileStale: (input: ProviderRuntimeReconcileInput) =>
    Effect.sync(() => {
      calls.push(input);
      return 1;
    }),
} as never);

const makeHygiene = (liveThreadIds: ReadonlyArray<string>) =>
  makeProviderRuntimeHygiene({
    orchestrationEngine: { dispatch: () => Effect.die("no tasks are settled without SQL") },
    providerService: {
      listSessions: () =>
        Effect.succeed(liveThreadIds.map((threadId) => ({ threadId }) as ProviderSession)),
    },
  }).pipe(Effect.provide(repositoryLayer));

const event = (type: string, threadId: string) => ({ type, threadId }) as ProviderRuntimeEvent;

it.effect("startup reconciles every row the probe did not find, skipping failed providers", () =>
  Effect.gen(function* () {
    calls.length = 0;
    const hygiene = yield* makeHygiene([]);
    yield* hygiene.afterStartupProbe({
      observedBefore: "2026-03-01T00:00:00.000Z",
      discovery: {
        sessions: [{ threadId: "live" } as ProviderSession],
        unavailableProviders: new Set(["claudeAgent"]),
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.liveThreadIds, ["live"]);
    assert.deepEqual(calls[0]?.unavailableProviders, ["claudeAgent"]);
    assert.equal(calls[0]?.observedBefore, "2026-03-01T00:00:00.000Z");
    assert.isUndefined(calls[0]?.threadIds);
  }),
);

it.effect("a turn that ends without a live session reconciles only that thread", () =>
  Effect.gen(function* () {
    calls.length = 0;
    const hygiene = yield* makeHygiene(["still-live"]);
    yield* hygiene.afterRuntimeEvent(event("turn.completed", "ended"));
    yield* hygiene.afterRuntimeEvent(event("session.exited", "exited"));
    // A live session, or an event that does not end a turn, leaves the row alone.
    yield* hygiene.afterRuntimeEvent(event("turn.completed", "still-live"));
    yield* hygiene.afterRuntimeEvent(event("turn.started", "ended"));
    assert.deepEqual(
      calls.map((call) => call.threadIds),
      [["ended"], ["exited"]],
    );
  }),
);
