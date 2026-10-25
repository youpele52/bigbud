import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

it("normal polling does not supersede the admission operation holding the owner queue while awaiting its valid ack", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("admission-poll-owner");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const entered = deferred<void>(),
      release = deferred<void>();
    const original = http.client.session.prompt.bind(http.client.session);
    const prompt = vi.spyOn(http.client.session, "prompt").mockImplementation(async (...args) => {
      const value = await original(...args);
      entered.resolve();
      await release.promise;
      return value;
    });
    try {
      const pending = runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe("valid-delayed-ack"),
        input: "fixture",
      });
      const observed = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 350)); // More than three real fixture polling intervals.
      release.resolve();
      expect(await observed).toBeUndefined();
      expect((await Effect.runPromise(runtime.options.journal.latestBound(threadId)))?.state).toBe(
        "accepted",
      );
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    } finally {
      release.resolve();
      prompt.mockRestore();
    }
  });
});
