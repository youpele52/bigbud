import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, it as vitestIt } from "vitest";

import { ProviderAdapterRequestError } from "../../Errors.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { makePiStopThreadSubagents, piAsyncRunIds } from "./Adapter.methods.threadSubagentStop.ts";

const threadId = ThreadId.makeUnsafe("thread-1");

describe("piAsyncRunIds", () => {
  vitestIt("takes each background run once from the decoded first native ID segment", () => {
    expect(
      piAsyncRunIds([
        { nativeId: "run-1", background: true },
        { nativeId: "run-1:child-a", background: true },
        { nativeId: `${encodeURIComponent("run/2")}:child-b`, background: true },
        { nativeId: "toolu_1:single:0", background: false },
        { nativeId: encodeURIComponent("bad id"), background: true },
        { nativeId: "%E0%A4%A", background: true },
      ]),
    ).toEqual(["run-1", "run/2"]);
  });
});

it.effect("sends one /subagents-stop per run and keeps going after a failure", () =>
  Effect.gen(function* () {
    const sent: unknown[] = [];
    const session = {
      process: {
        request: async (message: { readonly message: string }) => {
          sent.push(message);
          if (message.message.endsWith("run-1")) throw new Error("not running");
          return {};
        },
      },
    } as unknown as ActivePiSession;
    yield* makePiStopThreadSubagents({ requireSession: () => Effect.succeed(session) })(threadId, [
      { nativeId: "run-1:child", background: true },
      { nativeId: "run-2", background: true },
      { nativeId: "toolu_1:single:0", background: false },
    ]);
    assert.deepEqual(sent, [
      { type: "prompt", message: "/subagents-stop run-1" },
      { type: "prompt", message: "/subagents-stop run-2" },
    ]);
  }),
);

it.effect("does not touch the session when no background run is listed", () =>
  Effect.gen(function* () {
    const result = yield* makePiStopThreadSubagents({
      requireSession: () =>
        Effect.fail(
          new ProviderAdapterRequestError({ provider: "pi", method: "prompt", detail: "unused" }),
        ),
    })(threadId, [{ nativeId: "toolu_1:single:0", background: false }]);
    assert.isUndefined(result);
  }),
);
