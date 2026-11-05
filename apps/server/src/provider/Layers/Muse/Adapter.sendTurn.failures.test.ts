import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeMuseTestHost, startInput, threadId } from "./Adapter.failures.test.helpers.ts";
import { getMuseFailureEvidence } from "./Client.errors.ts";

describe("Muse turn admission failure boundaries", () => {
  it.each([
    [{ kind: "commandRejected", detail: "refused" }, "invalid-request"],
    [{ kind: "invalidParams" }, "invalid-request"],
    [new Error("commandRejected is only text"), "unsafe-to-replay"],
    [{ kind: "backpressure" }, "unsafe-to-replay"],
    [{ kind: "timeout" }, "unsafe-to-replay"],
    ["lost", "unsafe-to-replay"],
    [undefined, "unsafe-to-replay"],
  ] as const)(
    "classifies native failure without guessing or replaying: %j",
    async (cause, failureClass) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      let dispatches = 0;
      host.transport.command = async (method, params, cid) => {
        if (method === "turn/start") {
          dispatches++;
          throw cause;
        }
        return original(method, params, cid);
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* host.adapter();
          yield* adapter.startSession(startInput);
          const result = yield* adapter.sendTurn({ threadId, input: "work" }).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              _tag: "ProviderAdapterRequestError",
              failureClass,
            });
            expect(getMuseFailureEvidence(result.failure)).toBe(cause);
            expect(result.failure.cause).toBeUndefined();
          }
          expect(dispatches).toBe(1);
          yield* adapter.stopAll();
        }),
      );
    },
  );
  it("validates effort and model before session/setModel side effects", async () => {
    const host = makeMuseTestHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* host.adapter();
        yield* adapter.startSession(startInput);
        for (const selection of [
          { model: "other", options: { reasoningEffort: "turbo" } },
          { model: "default" },
          { model: "" },
          { model: "other", subProviderID: "other" },
        ]) {
          expect(
            (yield* adapter
              .sendTurn({
                threadId,
                input: "work",
                modelSelection: { provider: "muse", ...selection },
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          host.calls.some(
            (call) => call.method === "session/setModel" || call.method === "turn/start",
          ),
        ).toBe(false);
        yield* adapter.stopAll();
      }),
    );
  });
  it.each(["steered", "new-disposition"])(
    "treats an unsupported post-dispatch %s ack as unsafe to replay",
    async (disposition) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      host.transport.command = async (method, params, cid) => ({
        ...(await original(method, params, cid)),
        ...(method === "turn/start" ? { disposition } : {}),
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* host.adapter();
          yield* adapter.startSession(startInput);
          const result = yield* adapter.sendTurn({ threadId, input: "work" }).pipe(Effect.result);
          if (result._tag === "Success") throw new Error("unsupported ack succeeded");
          expect(result.failure.failureClass).toBe("unsafe-to-replay");
          yield* adapter.stopAll();
        }),
      );
    },
  );
});
