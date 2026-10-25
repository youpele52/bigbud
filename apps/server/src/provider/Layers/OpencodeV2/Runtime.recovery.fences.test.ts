import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

for (const race of ["epoch", "dirty-generation"] as const) {
  it(`does not commit an accepted journal claim from an admission read superseded by ${race}`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      const repair = vi.spyOn(runtime, "scheduleRepair").mockImplementation(() => {});
      http.loseAck = true;
      http.autoComplete = false;
      const threadId = ThreadId.makeUnsafe(`admission-read-${race}`);
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
      await expect(
        runtime.send({
          threadId,
          requestMessageId: MessageId.makeUnsafe("lost-admission-ack"),
          input: "fixture only",
        }),
      ).rejects.toThrow();
      const owner = runtime.get(threadId);
      const before = await Effect.runPromise(runtime.options.journal.latestBound(threadId));
      expect(before?.state).toBe("dispatch-intent");
      const entered = deferred<void>();
      const hold = deferred<void>();
      const original = http.client.session.inbox.list.bind(http.client.session.inbox);
      const read = vi
        .spyOn(http.client.session.inbox, "list")
        .mockImplementation(async (...args) => {
          const value = await original(...args);
          entered.resolve();
          await hold.promise;
          return value;
        });
      try {
        const pending = runtime.reconcile(owner);
        await entered.promise;
        if (race === "epoch") Object.assign(owner, { epoch: owner.epoch + 1 });
        else owner.dirtyGeneration++;
        hold.resolve();
        await pending;
        expect(await Effect.runPromise(runtime.options.journal.latestBound(threadId))).toEqual(
          before,
        );
        expect(owner.row).toEqual(before);
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      } finally {
        hold.resolve();
        read.mockRestore();
        repair.mockRestore();
      }
    });
  });
}
