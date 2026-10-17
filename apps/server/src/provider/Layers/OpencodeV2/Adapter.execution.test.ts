import { Deferred, Effect, Stream } from "effect";
import { expect, it } from "vitest";
import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("releases blocked canonical publishers before closing owned runtime resources", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, directory, http }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { adapter, runtime } = yield* makeIsolatedOpencodeV2Adapter({
            manager: fixture.options.manager,
            journal: fixture.options.journal,
            config: fixture.options.config,
          });
          const hold = yield* Deferred.make<void>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach(() => Deferred.await(hold)),
            Effect.forkScoped,
          );
          yield* Effect.sleep("10 millis");
          const threadId = ThreadId.makeUnsafe("blocked-publisher");
          yield* adapter.startSession({
            threadId,
            cwd: directory,
            runtimeMode: "approval-required",
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic-provider",
              model: "synthetic-model",
            },
          });
          const session = runtime.get(threadId);
          const publishing = Array.from({ length: 600 }, (_, index) =>
            runtime
              .emit(session, {
                eventId: EventId.makeUnsafe(`blocked:${index}`),
                provider: "opencodeV2",
                threadId,
                type: "runtime.warning",
                createdAt: new Date().toISOString(),
                payload: { message: "Synthetic backpressure" },
              })
              .catch(() => undefined),
          );
          yield* Effect.sleep("10 millis");
          yield* adapter.stopAll();
          yield* Effect.promise(() => Promise.allSettled(publishing));
          expect(runtime.sessions.size).toBe(0);
          expect(http.running).toBe(false);
        }),
      ),
    );
  });
}, 15000);
