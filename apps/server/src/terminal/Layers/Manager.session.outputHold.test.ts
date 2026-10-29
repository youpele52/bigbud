import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";

import { FakePtyProcess } from "./Manager.test.helpers";
import { makeTerminalOutputHold } from "./Manager.session.outputHold";
import type { SessionApiContext } from "./Manager.session.types.ts";

it.effect("keeps the PTY paused when a stale release resumes after a newer hold", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess(1);
    const lookups: Array<Deferred.Deferred<void>> = [];
    const getSession = (() =>
      Effect.gen(function* () {
        const lookup = yield* Deferred.make<void>();
        lookups.push(lookup);
        yield* Deferred.await(lookup);
        return Option.some({ process });
      })) as unknown as SessionApiContext["getSession"];
    const setHold = makeTerminalOutputHold(getSession);
    const hold = (holderId: string, held: boolean) =>
      setHold({ threadId: "thread-1", terminalId: "default", holderId, held }).pipe(
        Effect.forkChild,
      );

    // The first holder's set is emptied and replaced while every lookup is suspended.
    const first = yield* hold("first", true);
    const release = yield* hold("first", false);
    const second = yield* hold("second", true);
    yield* Effect.yieldNow;
    assert.equal(lookups.length, 3);

    // The newest hold resolves first; the stale calls resolve afterwards.
    for (const index of [2, 1, 0]) {
      yield* Deferred.succeed(lookups[index]!, undefined);
      yield* Effect.yieldNow;
    }
    yield* Fiber.join(second);
    yield* Fiber.join(release);
    yield* Fiber.join(first);

    assert.equal(process.paused, true);
  }),
);

it.effect("a renewed output hold cannot pause a terminal while its stop is awaiting exit", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess(1);
    const session = { process, stopPending: true };
    const getSession = (() =>
      Effect.succeed(Option.some(session))) as unknown as SessionApiContext["getSession"];
    const setHold = makeTerminalOutputHold(getSession);
    const request = {
      threadId: "thread-1",
      terminalId: "default",
      holderId: "slow-view",
      held: true,
    };
    yield* setHold(request);
    assert.equal(process.paused, false);
    session.stopPending = false;
    yield* setHold(request);
    assert.equal(process.paused, true);
  }),
);
