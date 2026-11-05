import { Effect } from "effect";
import { expect, it } from "vitest";
import { withWorkspaceApp, threadId } from "./Application.workspace.fixture.ts";
import { detachV2BorrowedRuntime } from "./Runtime.transport.ts";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { workspaceModel } from "./Application.workspace.fixture.ts";

it("retains the application session and automatically rebinds compatible idle generations without create/prompt/cancel", async () => {
  await withWorkspaceApp(false, async (h) => {
    await h.send("upgrade-first");
    const owner = h.runtime.get(threadId),
      emitted = owner.emitted;
    const cursor = owner.session.resumeCursor;
    const binding = await h.binding();
    for (const generation of ["upgrade-2", "upgrade-3"]) {
      const calls = h.http.calls.length;
      await detachV2BorrowedRuntime(h.runtime);
      h.runtime.options = {
        ...h.runtime.options,
        config: {
          runtimeTargetId: "local",
          sharedService: { ...h.runtime.options.config.sharedService!, generation },
        },
      };
      await h.runtime.reconnect(owner, new AbortController().signal, () => {});
      expect(owner.transportDetached).toBe(false);
      expect(owner.transportRecovering).toBe(false);
      expect(owner.executionBlocked).toBeUndefined();
      expect(owner.session.resumeCursor).toEqual(cursor);
      expect(owner.emitted).toBe(emitted);
      expect(h.http.calls.slice(calls).every((call) => call.method === "GET")).toBe(true);
    }
    expect((await h.binding()).resumeCursor).toEqual(binding.resumeCursor);
    await h.send("upgrade-second");
    expect(h.creations()).toHaveLength(1);
    expect(h.prompts()).toHaveLength(2);
  });
});

it("retains uncertain admission across replacement and settles only after exact native evidence arrives", async () => {
  await withWorkspaceApp(false, async (h) => {
    await h.send("prior-settled");
    h.http.hideAdmission = true;
    h.http.loseAck = true;
    await expect(
      h.runtime.send({
        threadId,
        modelSelection: workspaceModel,
        requestMessageId: MessageId.makeUnsafe("uncertain-upgrade"),
        input: "unconfirmed",
      }),
    ).rejects.toThrow();
    const owner = h.runtime.get(threadId),
      row = owner.row!;
    expect(row.state).toBe("dispatch-intent");
    const prompts = h.prompts().length;
    await detachV2BorrowedRuntime(h.runtime);
    await h.runtime.reconnect(owner, new AbortController().signal, () => {});
    expect(owner.row?.state).toBe("dispatch-intent");
    expect(owner.transportRecovering).toBe(true);
    expect(h.prompts()).toHaveLength(prompts);
    h.http.hideAdmission = false;
    h.http.loseAck = false;
    h.http.messages.get(owner.native.id)!.push({
      id: row.nativeAdmissionId,
      type: "user",
      text: "unconfirmed",
      time: { created: 2 },
      metadata: { bigbud_fingerprint: row.fingerprint },
    });
    h.http.complete(owner.native.id);
    await h.runtime.reconnect(owner, new AbortController().signal, () => {});
    expect(owner.row?.state).toBe("terminal");
    expect(owner.transportRecovering).toBe(false);
    expect(h.prompts()).toHaveLength(prompts);
  });
});

it.each(["missing", "metadata", "admission"])(
  "blocks %s retained native history without replacement or replay",
  async (change) => {
    await withWorkspaceApp(false, async (h) => {
      await h.send("upgrade-missing");
      const owner = h.runtime.get(threadId);
      await detachV2BorrowedRuntime(h.runtime);
      const saved = h.http.sessions.get(owner.native.id)!;
      const messages = h.http.messages.get(owner.native.id)!;
      if (change === "missing") h.http.sessions.delete(owner.native.id);
      if (change === "metadata")
        h.http.sessions.set(owner.native.id, {
          ...saved,
          metadata: { ...saved.metadata, bigbud_thread: "another-thread" },
        });
      if (change === "admission")
        h.http.messages.set(
          owner.native.id,
          messages.filter((message) => message.type !== "user"),
        );
      const before = h.http.calls.length;
      await expect(
        h.runtime.reconnect(owner, new AbortController().signal, () => {}),
      ).rejects.toThrow();
      expect(owner.transportDetached).toBe(true);
      expect(h.http.calls.slice(before).every((call) => call.method === "GET")).toBe(true);
      expect(h.creations()).toHaveLength(1);
      expect(h.prompts()).toHaveLength(1);
      h.http.sessions.set(owner.native.id, saved);
      h.http.messages.set(owner.native.id, messages);
      await h.runtime.reconnect(owner, new AbortController().signal, () => {});
      expect(owner.transportRecovering).toBe(false);
      expect(
        await Effect.runPromise(h.runtime.options.journal.latestBound(threadId)),
      ).toMatchObject({
        state: "terminal",
      });
    });
  },
);
