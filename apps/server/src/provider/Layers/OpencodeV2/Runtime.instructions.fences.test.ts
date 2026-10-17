import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred } from "./Test.fixtures.ts";

it("instruction verification cannot clear quarantine after losing the owner during readback", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    Object.assign(runtime.options, { enableLocalTools: true });
    const threadId = ThreadId.makeUnsafe("instruction-readback-fence");
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
    const entered = deferred<void>(),
      release = deferred<void>();
    const entries = http.client.session.instructions.entry;
    const list = entries.list;
    vi.spyOn(entries, "list")
      .mockImplementationOnce(list)
      .mockImplementationOnce(async (...args) => {
        const result = await list(...args);
        entered.resolve();
        await release.promise;
        return result;
      });
    const pending = runtime.send({
      threadId,
      requestMessageId: MessageId.makeUnsafe("instruction-readback"),
      input: "held",
    });
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    const generation = owner.lease.generation;
    Object.assign(owner.lease, { generation: generation + 1 });
    release.resolve();
    try {
      await rejected;
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
      expect(owner.row?.state).toBe("dispatch-intent");
    } finally {
      Object.assign(owner.lease, { generation });
    }
  });
});
