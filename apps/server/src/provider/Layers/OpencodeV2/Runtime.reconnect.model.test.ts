import { expect, it } from "vitest";
import { withWorkspaceApp, threadId } from "./Application.workspace.fixture.ts";
import { detachV2BorrowedRuntime } from "./Runtime.transport.ts";

it("reconnects when native materializes the default variant without rewriting history or replaying", async () => {
  await withWorkspaceApp(false, async (h) => {
    await h.send("before-default-materialized");
    const owner = h.runtime.get(threadId);
    const cursor = structuredClone(owner.session.resumeCursor);
    const native = h.http.sessions.get(owner.native.id)!;
    h.http.sessions.set(native.id, {
      ...native,
      model: { ...native.model!, variant: "default" },
    });
    await detachV2BorrowedRuntime(h.runtime);
    const before = h.http.calls.length;
    try {
      await h.runtime.reconnect(owner, new AbortController().signal, () => {});
    } catch (error) {
      // Restore fixture transport so teardown cannot mask the reconnect regression.
      h.http.sessions.set(native.id, native);
      await h.runtime.reconnect(owner, new AbortController().signal, () => {});
      throw error;
    }
    expect(owner.transportRecovering).toBe(false);
    expect(owner.session.resumeCursor).toEqual(cursor);
    expect(h.http.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
    expect(h.prompts()).toHaveLength(1);
    await h.send("after-default-materialized");
    expect(h.creations()).toHaveLength(1);
    expect(h.prompts()).toHaveLength(2);
  });
});

it.each(["provider", "model", "variant"])(
  "refuses a changed native %s during reconnect without replay or replacement",
  async (change) => {
    await withWorkspaceApp(false, async (h) => {
      await h.send("before-model-conflict");
      const owner = h.runtime.get(threadId);
      const native = h.http.sessions.get(owner.native.id)!;
      await detachV2BorrowedRuntime(h.runtime);
      h.http.sessions.set(native.id, {
        ...native,
        model: {
          ...native.model!,
          ...(change === "provider" ? { providerID: "another-provider" } : {}),
          ...(change === "model" ? { id: "second-model" } : {}),
          ...(change === "variant" ? { variant: "high" } : {}),
        },
      });
      const before = h.http.calls.length;
      await expect(
        h.runtime.reconnect(owner, new AbortController().signal, () => {}),
      ).rejects.toThrow();
      expect(owner.transportDetached).toBe(true);
      expect(h.http.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
      expect(h.creations()).toHaveLength(1);
      expect(h.prompts()).toHaveLength(1);
      h.http.sessions.set(native.id, native);
      await h.runtime.reconnect(owner, new AbortController().signal, () => {});
    });
  },
);
