import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";
import { deferred } from "./Test.fixtures.ts";

for (const settlement of ["success", "rejection"] as const) {
  it(`100 post-deadline polls add no raw subscriptions/timers; late ${settlement} repairs the exact owner`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const threadId = ThreadId.makeUnsafe(`constant-observation-${settlement}`);
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
      const owner = runtime.get(threadId);
      http.forms.set(owner.native.id, [
        {
          id: "frm_observation",
          sessionID: owner.native.id,
          title: "Choice",
          fields: [{ key: "answer", type: "string" }],
          state: { status: "pending" },
        },
      ]);
      for (const event of await pendingV2Interactions(owner)) await runtime.emit(owner, event);
      const sink = runtime.options.emit;
      const entered = deferred<void>();
      const gate = deferred<void>();
      let calls = 0;
      Object.assign(runtime.options, {
        emit: async (event: Parameters<typeof sink>[0]) => {
          if (event.type === "user-input.resolved" && ++calls === 1) {
            entered.resolve();
            await gate.promise;
            if (settlement === "rejection") throw new Error("late synthetic rejection");
          }
          await sink(event);
        },
      });
      const polling = vi.spyOn(runtime, "scheduleRepair").mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const stop = runtime.stop(threadId);
        const rejected = expect(stop).rejects.toThrow();
        await entered.promise;
        await vi.advanceTimersByTimeAsync(1001);
        await rejected;
        const publication = owner.finalPublication!;
        const subscriptions = vi.spyOn(publication.operation, "then");
        const timers = vi.getTimerCount();
        for (let i = 0; i < 100; i++) {
          await expect(runtime.reconcile(owner)).rejects.toThrow("pending");
          await vi.advanceTimersByTimeAsync(1001);
        }
        expect(subscriptions).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(timers);
        expect(calls).toBe(1);
        expect(runtime.teardown.has(threadId)).toBe(true);
        gate.resolve();
        vi.useRealTimers();
        await expect
          .poll(() => publication.state)
          .toBe(settlement === "success" ? "succeeded" : "failed");
        await runtime.reconcile(owner);
        polling.mockRestore();
        expect(calls).toBe(settlement === "success" ? 1 : 2);
        expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(1);
        expect(events.filter((event) => event.type === "session.exited")).toHaveLength(1);
        expect(runtime.teardown.has(threadId)).toBe(false);
      } finally {
        gate.resolve();
        polling.mockRestore();
        vi.useRealTimers();
      }
    });
  });
}
