import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("reattaches the saved model after restart, then switches only a new idle turn without replacing history", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("resume-model");
    const modelSelection = {
      provider: "opencodeV2" as const,
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    };
    const start = {
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required" as const,
    };
    const started = await runtime.start(start);
    const original = {
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("original"),
      input: "first",
    };
    const first = await runtime.send(original);
    await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
    const nativeId = runtime.get(threadId).native.id;
    const lease = await runtime.options.manager.acquire(runtime.options.config);
    try {
      await runtime.stop(threadId);
      const next = { ...modelSelection, model: "second-model", options: { variant: "precise" } };
      const resumed = await runtime.start({
        ...start,
        modelSelection: next,
        resumeCursor: started.resumeCursor,
      });
      expect(resumed.model).toBe("synthetic-model");
      expect(runtime.get(threadId).native.id).toBe(nativeId);
      expect(
        http.calls.filter((call) => call.pathname.endsWith("/model") && call.method === "POST"),
      ).toHaveLength(0);
      expect((await runtime.send(original)).turnId).toBe(first.turnId);
      await runtime.send({
        ...original,
        requestMessageId: MessageId.makeUnsafe("next"),
        input: "second",
        modelSelection: next,
      });
      await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
      expect(runtime.get(threadId).session.model).toBe("second-model");
      expect(runtime.get(threadId).session.resumeCursor).toMatchObject({
        nativeSessionId: nativeId,
        model: { id: "second-model", variant: "precise" },
      });
      expect(
        http.calls.filter((call) => call.pathname.endsWith("/model") && call.method === "POST"),
      ).toHaveLength(1);
      expect(
        http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
      ).toHaveLength(1);
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
    } finally {
      await lease.release();
    }
  });
});
