import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Queue } from "effect";

import {
  PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY,
  makeProviderAdapterEventQueue,
} from "./providerEventQueueBounds";

it.effect("a full adapter queue suspends the producer and loses no event", () =>
  Effect.gen(function* () {
    const queue = yield* makeProviderAdapterEventQueue<number>();
    const total = PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY * 3;
    const producer = yield* Effect.forEach(
      Array.from({ length: total }, (_, index) => index),
      (index) => Queue.offer(queue, index),
      { discard: true },
    ).pipe(Effect.forkChild);
    for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;

    // The producer waits at the bound instead of growing the queue.
    assert.strictEqual(yield* Queue.size(queue), PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY);
    assert.isUndefined(producer.pollUnsafe());

    const received: Array<number> = [];
    while (received.length < total) received.push(yield* Queue.take(queue));
    yield* Fiber.join(producer);
    assert.deepEqual(
      received,
      Array.from({ length: total }, (_, index) => index),
    );
  }),
);

const sourceFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith(".ts") && !name.includes(".test") && !name.includes("fixture")
      ? [full]
      : [];
  });

it("no provider adapter creates an unbounded runtime-event queue or PubSub", () => {
  const offenders = sourceFiles(path.join(import.meta.dirname, "Layers"))
    .concat(sourceFiles(path.join(import.meta.dirname, "acp")))
    .filter((file) =>
      /(Queue|PubSub)\.unbounded<(ProviderRuntimeEvent|AcpParsedSessionEvent)>/.test(
        readFileSync(file, "utf8"),
      ),
    )
    .map((file) => path.relative(import.meta.dirname, file));
  // ProviderService's fan-out PubSub is the one intended exception (consumers bound themselves).
  assert.deepEqual(offenders, ["Layers/ProviderService.ts"]);
});
