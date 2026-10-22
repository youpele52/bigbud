import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import type { ProviderThreadSubagentRef } from "../Services/ProviderAdapter.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";
import { makeStopThreadSubagents } from "./ProviderService.threadSubagentStop.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const subagents: ReadonlyArray<ProviderThreadSubagentRef> = [
  { nativeId: "fg", background: false },
  { nativeId: "bg", background: true },
];

const stopWith = (adapter: object) =>
  makeStopThreadSubagents({
    resolveRoutableSession: (() =>
      Effect.succeed({ adapter, threadId })) as unknown as ResolveRoutableSession,
  });

it.effect("prefers the adapter's own thread-subagent cascade", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    yield* stopWith({
      capabilities: { subagents: { stop: true } },
      stopThreadSubagents: (_: ThreadId, refs: ReadonlyArray<ProviderThreadSubagentRef>) =>
        Ref.update(calls, (all) => [...all, ["cascade", refs]]),
      stopSubagent: (_: ThreadId, nativeId: string) =>
        Ref.update(calls, (all) => [...all, ["single", nativeId]]),
    })({ threadId, subagents });
    assert.deepEqual(yield* Ref.get(calls), [["cascade", subagents]]);
  }),
);

it.effect("falls back to per-subagent Stop, tolerating rejected stops", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* stopWith({
      capabilities: { subagents: { stop: true } },
      stopSubagent: (_: ThreadId, nativeId: string) =>
        Ref.update(calls, (all) => [...all, nativeId]).pipe(
          Effect.andThen(nativeId === "fg" ? Effect.fail("already ended") : Effect.void),
        ),
    })({ threadId, subagents });
    assert.deepEqual(yield* Ref.get(calls), ["fg", "bg"]);
  }),
);

it.effect("relies on the turn interrupt when the provider offers no subagent stop", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* stopWith({
      capabilities: { subagents: { stop: false } },
      stopSubagent: (_: ThreadId, nativeId: string) =>
        Ref.update(calls, (all) => [...all, nativeId]),
    })({ threadId, subagents });
    assert.deepEqual(yield* Ref.get(calls), []);
  }),
);
