import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { suspendV2BorrowedOwner } from "./Runtime.transport.ts";

it("suspends borrowed owners without cancelling native work or discarding admission/dedupe state", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("borrowed-generation-loss");
    const modelSelection = {
      provider: "opencodeV2",
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    } as const;
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    await runtime.send({
      threadId,
      modelSelection,
      input: "retained",
      requestMessageId: MessageId.makeUnsafe("borrowed-admission"),
    });
    const owner = runtime.get(threadId);
    const row = owner.row!,
      messages = owner.messages,
      emitted = owner.emitted;
    const before = http.calls.length;
    const cancel = vi.fn(async () => {}),
      revoke = vi.fn(),
      cleanup = vi.fn(async () => {});
    const originalOwnership = owner.lease.process.ownership;
    Object.assign(owner.lease.process, { ownership: "borrowed" });
    owner.coding = { pending: () => [], revoke, cancelActive: cancel };
    const originalResources = owner.resources;
    Object.assign(owner, { resources: { cleanup } });
    try {
      const epoch = owner.epoch;
      http.die();
      suspendV2BorrowedOwner(owner);
      await runtime.reconcile(owner);
      expect(owner.epoch).toBe(epoch);
      expect(owner.transportRevision).toBe(1);
      expect(owner.stopped).toBe(false);
      expect(owner.transportDetached).toBe(true);
      expect(runtime.sessions.get(threadId)).toBe(owner);
      expect(owner.row).toBe(row);
      expect(owner.messages).toBe(messages);
      expect(owner.emitted).toBe(emitted);
      expect(owner.session.activeTurnId).toBe(row.turnId);
      expect((await Effect.runPromise(runtime.options.journal.find(row)))?.state).toBe("accepted");
      await expect(
        runtime.send({ threadId, modelSelection, input: "never resend" }),
      ).rejects.toThrow("reconnecting");
      expect(http.calls).toHaveLength(before);
      expect(cancel).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      expect(
        events.some((event) => event.type === "turn.aborted" || event.type === "session.exited"),
      ).toBe(false);
    } finally {
      Object.assign(owner.lease.process, { ownership: originalOwnership });
      Object.assign(owner, { resources: originalResources });
      owner.transportDetached = false;
    }
  });
});
