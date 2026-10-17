import { Effect, Fiber } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import { deferred } from "./Test.fixtures.ts";

it("interruption during the final admission model read creates no new journal reservation or prompt", async () => {
  await withV2RuntimeFixture(async ({ runtime: base, http, directory }) => {
    const entered = deferred<void>(),
      held = deferred<void>(),
      threadId = ThreadId.makeUnsafe("cancel-final-admission-model"),
      requestMessageId = MessageId.makeUnsafe("cancel-before-journal-reservation");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { adapter, runtime } = yield* makeV2RuntimeAdapter(base.options);
          yield* adapter.startSession({
            threadId,
            cwd: directory,
            runtimeMode: "full-access",
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic-provider",
              model: "synthetic-model",
            },
          });
          const previous = JSON.stringify([...http.sessions.values()]);
          const model = http.client.model.list;
          const delayed = vi
            .spyOn(http.client.model, "list")
            .mockImplementation(async (...args) => {
              const response = await model(...args);
              entered.resolve();
              await held.promise;
              return response;
            });
          const reserve = vi.spyOn(runtime.options.journal, "reserve");
          try {
            const fiber = yield* adapter
              .sendTurn({ threadId, input: "never admit this input", requestMessageId })
              .pipe(Effect.forkScoped);
            yield* Effect.promise(() => entered.promise);
            yield* Fiber.interrupt(fiber);
            held.resolve();
            yield* Effect.promise(async () => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              expect(reserve).not.toHaveBeenCalled();
              expect(
                await Effect.runPromise(
                  runtime.options.journal.find({
                    namespace: "foreground",
                    ownerThreadId: threadId,
                    requestMessageId,
                  }),
                ),
              ).toBeUndefined();
              expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
                0,
              );
              expect(JSON.stringify([...http.sessions.values()])).toBe(previous);
            });
          } finally {
            held.resolve();
            delayed.mockRestore();
            reserve.mockRestore();
          }
        }),
      ),
    );
  });
});
