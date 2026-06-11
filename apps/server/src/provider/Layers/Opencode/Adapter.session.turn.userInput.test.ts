import { ApprovalRequestId, ThreadId } from "@bigbud/contracts";
import { it } from "@effect/vitest";
import { assert } from "chai";
import { Effect } from "effect";

import { makeTurnMethods } from "./Adapter.session.turn.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-attachment-test");

it.effect("maps OpenCode user-input answers from stable, header, and question keys", () => {
  const replies: Array<{ requestID: string; answers: Array<Array<string>> }> = [];

  const record = {
    client: {
      question: {
        reply: async (input: { requestID: string; answers: Array<Array<string>> }) => {
          replies.push(input);
          return { data: {}, error: undefined };
        },
      },
    },
    pendingUserInputs: new Map([
      [
        "req-opencode-question",
        {
          turnId: undefined,
          questions: [
            { header: "Scope" },
            { header: "Mode", question: "Which mode?" },
            { header: "Targets" },
          ],
        },
      ],
    ]),
  };

  const emitted: Array<unknown> = [];
  const { respondToUserInput } = makeTurnMethods({
    provider: "opencode",
    requireSession: () => Effect.succeed(record as never),
    syntheticEventFn: (threadId, type, payload, extra) =>
      Effect.succeed({
        threadId,
        type,
        payload,
        ...(extra?.requestId ? { requestId: extra.requestId } : {}),
      } as never),
    emitFn: (runtimeEvents) =>
      Effect.sync(() => {
        emitted.push(...runtimeEvents);
      }),
    teardownSessionRecord: () => Effect.void,
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });

  return Effect.gen(function* () {
    yield* respondToUserInput(THREAD_ID, ApprovalRequestId.makeUnsafe("req-opencode-question"), {
      "0-scope": "All providers",
      "Which mode?": "Fast",
      Targets: ["server", 42, "web"],
    });

    assert.deepEqual(replies, [
      {
        requestID: "req-opencode-question",
        answers: [["All providers"], ["Fast"], ["server", "web"]],
      },
    ]);
    assert.equal(emitted.length, 1);
  });
});
