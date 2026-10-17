import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { v2InstructionEntries, v2InstructionRevision } from "./Runtime.instructions.ts";

it("refreshes only owned instructions for new turns, fingerprints revisions, and preserves replay context and user keys", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    Object.assign(runtime.options, { enableLocalTools: true });
    const threadId = ThreadId.makeUnsafe("instruction-thread");
    const modelSelection = {
      provider: "opencodeV2" as const,
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    };
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection,
    });
    const owner = runtime.get(threadId);
    const userEntry = { key: "user.guidance", value: "never erase this" };
    http.instructions.set(owner.native.id, [
      userEntry,
      { key: "bigbud.preview.v1.browser", value: "obsolete" },
    ]);
    const original = {
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("instruction-original"),
      input: "first",
    };
    const first = await runtime.send(original);
    await expect.poll(() => owner.terminalDelivered).toBe(true);
    const firstPrompt = http.calls.find((call) => call.pathname.endsWith("/prompt"))!;
    expect(firstPrompt.body.metadata).toMatchObject({
      bigbud_instruction_revision: v2InstructionRevision(v2InstructionEntries(owner)),
    });
    expect(http.instructions.get(owner.native.id)).toContainEqual(userEntry);
    expect(
      http.instructions.get(owner.native.id)?.some((entry) => entry.key.endsWith("browser")),
    ).toBe(false);
    owner.session = { ...owner.session, runtimeMode: "full-access" }; // Simulate changed provider context, not changed admission identity.
    const calls = http.calls.filter(
      (call) => call.pathname.includes("/instructions/entries") && call.method !== "GET",
    ).length;
    expect((await runtime.send(original)).turnId).toBe(first.turnId);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    expect(
      http.calls.filter(
        (call) => call.pathname.includes("/instructions/entries") && call.method !== "GET",
      ),
    ).toHaveLength(calls);
    await runtime.send({
      ...original,
      input: "second",
      requestMessageId: MessageId.makeUnsafe("instruction-next"),
    });
    await expect.poll(() => owner.terminalDelivered).toBe(true);
    expect(http.instructions.get(owner.native.id)).toContainEqual(userEntry);
    expect(
      http.instructions.get(owner.native.id)?.find((entry) => entry.key.endsWith("access"))?.value,
    ).toContain("full-access");
    const secondPrompt = http.calls.filter((call) => call.pathname.endsWith("/prompt"))[1]!;
    expect(secondPrompt.body.metadata).not.toEqual(firstPrompt.body.metadata);
    await expect(
      runtime.send({ ...original, input: "changed identity material" }),
    ).rejects.toThrow();
  });
});

it("failed instruction mutation retains durable uncertainty and never dispatches or retries its prompt", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    Object.assign(runtime.options, { enableLocalTools: true });
    const threadId = ThreadId.makeUnsafe("instruction-failed");
    const modelSelection = {
      provider: "opencodeV2" as const,
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    };
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection,
    });
    const put = vi
      .spyOn(http.client.session.instructions.entry, "put")
      .mockRejectedValue(new Error("lost mutation acknowledgement"));
    const input = {
      threadId,
      modelSelection,
      input: "bounded",
      requestMessageId: MessageId.makeUnsafe("instruction-uncertain"),
    };
    await expect(runtime.send(input)).rejects.toThrow();
    await expect(runtime.send(input)).rejects.toThrow("quarantined");
    expect(put).toHaveBeenCalledTimes(1);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    expect(runtime.get(threadId).row?.state).not.toBe("terminal");
  });
});

for (const disableAt of ["instruction-read", "instruction-put"] as const) {
  it(`settings disabled during ${disableAt} reject subsequent mutations/prompt dispatch`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      let enabled = true;
      Object.assign(runtime.options, {
        enableLocalTools: true,
        authorizeExecution: async () => {
          if (!enabled) throw new Error("disabled");
        },
      });
      const threadId = ThreadId.makeUnsafe(`instruction-disable-${disableAt}`);
      const modelSelection = {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      };
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection,
      });
      const entries = http.client.session.instructions.entry;
      if (disableAt === "instruction-read") {
        const list = entries.list;
        vi.spyOn(entries, "list").mockImplementationOnce(async (...args) => {
          const result = await list(...args);
          enabled = false;
          return result;
        });
      } else {
        const put = entries.put;
        vi.spyOn(entries, "put").mockImplementationOnce(async (...args) => {
          await put(...args);
          enabled = false;
        });
      }
      const input = {
        threadId,
        modelSelection,
        input: "new",
        requestMessageId: MessageId.makeUnsafe(`disable-${disableAt}`),
      };
      await expect(runtime.send(input)).rejects.toThrow();
      expect(runtime.get(threadId).row?.state).toBe("dispatch-intent");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
      const mutations = http.calls.filter(
        (call) => call.pathname.includes("/instructions/entries") && call.method !== "GET",
      );
      expect(mutations).toHaveLength(disableAt === "instruction-read" ? 0 : 1);
      expect(() => runtime.mutations.assertSafe()).not.toThrow();
      enabled = true;
      await expect(runtime.send(input)).rejects.toThrow();
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(0);
    });
  });
}
