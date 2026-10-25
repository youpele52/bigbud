import { Effect, Fiber } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2RuntimeAdapter } from "./Adapter.runtime.ts";
import { V2ActivationJobs } from "./PluginSetup.activation.jobs.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { deferred } from "./Test.fixtures.ts";
import type { borrowV2SharedService } from "./SharedService.connection.ts";

it.each(["setup", "queue", "explicit-start"] as const)(
  "interrupting the actual adapter during %s admits no cancelled prompt and preserves another job interest",
  async (phase) => {
    await withV2RuntimeFixture(async ({ runtime: base, http, directory }) => {
      const f = await makeV2ActivationJobsFixture(),
        held = deferred<void>(),
        entered = deferred<void>();
      const jobs = new V2ActivationJobs(
        f.consent,
        async (job) => {
          job.phase("waiting-for-idle");
          await held.promise;
          job.assertCurrent();
        },
        async () =>
          ({ close: async () => {} }) as unknown as Awaited<
            ReturnType<typeof borrowV2SharedService>
          >,
      );
      let waiting = false;
      const id = ThreadId.makeUnsafe("cancelled-adapter-send"),
        request = MessageId.makeUnsafe("cancelled-input");
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const { adapter, runtime } = yield* makeV2RuntimeAdapter({
                ...base.options,
                enableLocalTools: true,
                threadToolsPreflight: async (_client, _cwd, signal) => {
                  if (!waiting) return;
                  const handle = jobs.request(f.scope, signal);
                  entered.resolve();
                  await jobs.wait(handle, f.scope, signal);
                },
              });
              const start = adapter.startSession({
                threadId: id,
                cwd: directory,
                modelSelection: {
                  provider: "opencodeV2",
                  subProviderID: "synthetic-provider",
                  model: "synthetic-model",
                },
                runtimeMode: "full-access",
              });
              if (phase !== "explicit-start") yield* start;
              waiting = phase !== "queue";
              const other = jobs.request(f.scope);
              const queued =
                phase === "queue"
                  ? runtime.withSession(id, async () => {
                      entered.resolve();
                      await held.promise;
                    })
                  : undefined;
              const operation =
                phase === "explicit-start"
                  ? start
                  : adapter.sendTurn({
                      threadId: id,
                      input: "must never submit",
                      requestMessageId: request,
                    });
              const fiber = yield* operation.pipe(Effect.forkScoped);
              yield* Effect.promise(() => entered.promise);
              yield* Fiber.interrupt(fiber);
              held.resolve();
              if (queued) yield* Effect.promise(() => queued);
              yield* Effect.promise(async () => {
                expect(await jobs.wait(other, f.scope)).toMatchObject({ state: "ready" });
                await new Promise((resolve) => setTimeout(resolve, 150));
                expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
                  0,
                );
                expect(
                  await Effect.runPromise(
                    runtime.options.journal.find({
                      namespace: "foreground",
                      ownerThreadId: id,
                      requestMessageId: request,
                    }),
                  ),
                ).toBeUndefined();
                if (phase === "explicit-start") {
                  expect(http.sessions.size).toBe(0);
                  expect(runtime.sessions.size).toBe(0);
                }
              });
            }),
          ),
        );
      } finally {
        held.resolve();
        await jobs.close();
        f.consent.close();
      }
    });
  },
);
