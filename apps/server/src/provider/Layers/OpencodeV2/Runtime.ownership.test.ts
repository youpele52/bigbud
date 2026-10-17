import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

const selection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

for (const field of [
  "bigbud_provider",
  "bigbud_thread",
  "bigbud_storage",
  "permissions",
] as const) {
  it(`rejects shared-session ${field} changes before model, instructions or prompt mutation`, async () => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      Object.assign(runtime.options, { enableLocalTools: true });
      const threadId = ThreadId.makeUnsafe(`shared-owner-${field}`);
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection: selection,
      });
      const owner = runtime.get(threadId);
      Object.assign(owner.lease.process, { ownership: "borrowed" });
      const original = http.sessions.get(owner.native.id)!;
      http.sessions.set(owner.native.id, {
        ...original,
        ...(field === "permissions"
          ? { permissions: [{ action: "*", resource: "*", effect: "allow" as const }] }
          : { metadata: { ...original.metadata, [field]: "not-this-bigbud-owner" } }),
      });
      const callsBefore = http.calls.length;
      try {
        await expect(
          runtime.send({
            threadId,
            requestMessageId: MessageId.makeUnsafe(`rejected-${field}`),
            modelSelection: { ...selection, model: "second-model" },
            input: "must not be submitted",
          }),
        ).rejects.toThrow("ownership/access policy changed");
        expect(http.calls.slice(callsBefore).every((call) => call.method === "GET")).toBe(true);
        expect(owner.row).toBeUndefined();
        expect(() => runtime.mutations.assertSafe()).not.toThrow();
      } finally {
        http.sessions.set(owner.native.id, original);
      }
    });
  });
}

it("does not interrupt a shared native session that no longer belongs to this thread", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("shared-interrupt-owner");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: selection,
    });
    const owner = runtime.get(threadId);
    Object.assign(owner.lease.process, { ownership: "borrowed" });
    const original = http.sessions.get(owner.native.id)!;
    http.sessions.set(owner.native.id, {
      ...original,
      metadata: { ...original.metadata, bigbud_thread: "another-thread" },
    });
    const callsBefore = http.calls.length;
    try {
      await expect(runtime.interrupt(threadId)).rejects.toThrow("ownership/access policy changed");
      expect(http.calls.slice(callsBefore).every((call) => call.method === "GET")).toBe(true);
    } finally {
      http.sessions.set(owner.native.id, original);
    }
  });
});
