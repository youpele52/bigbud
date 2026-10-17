import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ProviderTurnAdmissionConflict } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("independent foreground/delegated text owners stop/reopen retained history without replay or native history deletion", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const discovery = await runtime.options.manager.acquire(runtime.options.config);
    try {
      const parent = ThreadId.makeUnsafe("workload-parent");
      const child = ThreadId.makeUnsafe("workload-child");
      for (const threadId of [parent, child]) {
        await runtime.start({
          threadId,
          cwd: directory,
          modelSelection,
          runtimeMode: "approval-required",
        });
        await runtime.send({
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe(`message-${threadId}`),
          input: "synthetic text",
        });
        await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
      }
      const parentNative = runtime.get(parent).native.id;
      const childOwner = runtime.get(child);
      await runtime.stop(parent);
      expect(runtime.get(child)).toBe(childOwner);
      expect(http.sessions.has(parentNative)).toBe(true);
      const before = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
      const completed = events.filter((event) => event.type === "turn.completed");
      expect(completed.map((event) => event.threadId)).toEqual([parent, child]);
      await runtime.start({
        threadId: parent,
        cwd: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      expect(runtime.get(parent).native.id).toBe(parentNative);
      expect((await runtime.read(parent)).turns).toHaveLength(1);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(before);
      expect(http.calls.some((call) => call.method === "DELETE")).toBe(false);
      const replay = events
        .filter((event) => event.type === "turn.completed")
        .slice(completed.length);
      expect(replay).toHaveLength(1);
      expect(replay[0]?.eventId).toBe(completed[0]?.eventId);
    } finally {
      await discovery.release();
    }
  });
});

it("deleted owner gate runs before acquiring a native session or returning a learning result", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const gate = vi
      .spyOn(runtime.options.journal, "assertOwnerAvailable")
      .mockImplementation(() =>
        Effect.fail(new ProviderTurnAdmissionConflict({ detail: "deleted owner" })),
      );
    const threadId = ThreadId.makeUnsafe("deleted-workload-owner");
    await expect(
      runtime.start({ threadId, cwd: directory, modelSelection, runtimeMode: "approval-required" }),
    ).rejects.toThrow();
    expect(http.calls).toHaveLength(0);
    await expect(
      Effect.runPromise(
        makeV2LearningReview(runtime)({
          ownerThreadId: threadId,
          jobId: "deleted-job",
          cwd: directory,
          input: "synthetic",
          modelSelection,
        }),
      ),
    ).rejects.toThrow();
    expect(gate).toHaveBeenLastCalledWith(threadId);
    expect(http.calls).toHaveLength(0);
  });
});
