import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalEventsStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import type * as Cause from "effect/Cause";

import { makeBoundedTerminalEventOffer } from "./wsRpcHandlers.terminalEvents.ts";

const output = (data: string): TerminalEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-10-29T00:00:00.000Z",
  data,
});

const exited: TerminalEvent = {
  type: "exited",
  threadId: "thread-1",
  terminalId: "default",
  createdAt: "2026-10-29T00:00:01.000Z",
  exitCode: 0,
  exitSignal: null,
};

const limits = { chars: 10, items: 3 } as const;

it.effect(
  "ends a lifecycle-only backlog and releases queued references at its hard item limit",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
      const offer = makeBoundedTerminalEventOffer(queue, { ...limits, totalItems: 2 });
      yield* offer(exited);
      yield* offer(exited);
      assert.equal(Queue.sizeUnsafe(queue), 2);
      yield* offer(exited);
      assert.equal(Queue.sizeUnsafe(queue), 0);
      yield* offer(output("late"));
      yield* offer(exited);
      assert.equal(Queue.sizeUnsafe(queue), 0);
      assert.equal((yield* Queue.take(queue).pipe(Effect.result))._tag, "Failure");
    }),
);

it.effect("accounts for snapshot history and refuses an oversized first lifecycle event", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, { ...limits, totalChars: 1024 });
    yield* offer({
      type: "started",
      threadId: "thread-1",
      terminalId: "default",
      createdAt: exited.createdAt,
      snapshot: {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/project",
        worktreePath: null,
        dropPathMode: "posix",
        status: "running",
        pid: 1,
        history: "x".repeat(2048),
        exitCode: null,
        exitSignal: null,
        updatedAt: exited.createdAt,
      },
    });
    assert.equal(Queue.sizeUnsafe(queue), 0);
    assert.equal((yield* Queue.take(queue).pipe(Effect.result))._tag, "Failure");
  }),
);

it.effect("treats inventory as lossless and never delivers a partial oversized inventory", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEventsStreamItem, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, { ...limits, totalChars: 1024 });
    yield* offer({
      type: "inventory",
      createdAt: exited.createdAt,
      sessions: Array.from({ length: 100 }, (_, index) => ({
        threadId: "thread",
        terminalId: `terminal-${index}`,
      })),
    });
    assert.equal(Queue.sizeUnsafe(queue), 0);
    assert.equal((yield* Queue.take(queue).pipe(Effect.result))._tag, "Failure");
  }),
);

it.effect("drops an oversized first output without ending the lossless stream", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, { ...limits, totalChars: 1024 });
    yield* offer(output("x".repeat(2048)));
    yield* offer(exited);
    assert.deepStrictEqual(yield* Queue.takeAll(queue), [exited]);
  }),
);

it.effect("drops output past the character backlog but keeps lifecycle events", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, limits);

    yield* offer(output("123456"));
    yield* offer(output("abcdef"));
    yield* offer(exited);

    const queued = yield* Queue.takeAll(queue);
    assert.deepStrictEqual(
      queued.map((event) => event.type),
      ["output", "exited"],
    );
  }),
);

it.effect("always admits the first output event into an empty backlog", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, limits);

    yield* offer(output("x".repeat(50)));
    yield* offer(output("dropped"));

    const queued = yield* Queue.takeAll(queue);
    assert.equal(queued.length, 1);
  }),
);

it.effect("drops output past the item backlog", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, limits);

    for (let index = 0; index < 5; index += 1) yield* offer(output("x"));

    assert.equal((yield* Queue.takeAll(queue)).length, 3);
  }),
);

it.effect("accepts output again once the subscriber drained its queue", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<TerminalEvent, Cause.Done>();
    const offer = makeBoundedTerminalEventOffer(queue, limits);

    yield* offer(output("1234567890"));
    yield* offer(output("dropped"));
    yield* Queue.takeAll(queue);
    yield* offer(output("after"));

    const queued = yield* Queue.takeAll(queue);
    assert.deepStrictEqual(
      queued.map((event) => (event.type === "output" ? event.data : event.type)),
      ["after"],
    );
  }),
);
